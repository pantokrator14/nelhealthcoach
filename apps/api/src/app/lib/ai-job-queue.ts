/**
 * ai-job-queue.ts
 *
 * Cola de trabajos de IA 100% propia sobre MongoDB (patrón "claim-on-poll"):
 *  - POST /ai NO ejecuta la generación: crea un job (status 'pending') y
 *    responde 202 { status: 'queued', jobId } — el frontend ya sabe pollear.
 *  - GET /ai (el polling del dashboard) actúa de worker: reclama el job
 *    ATOMICAMENTE (findOneAndUpdate con condición) y ejecuta la generación
 *    en ese mismo request (hasta el límite de Vercel), guardando la sesión.
 *  - Lease: si el request que ejecuta muere (timeout de Vercel, red), el job
 *    queda 'running' con claimedAt viejo y otro poll puede reclamarlo
 *    (reintento automático, hasta MAX_ATTEMPTS).
 *
 * Sin dependencias externas: solo MongoDB (ya en producción).
 */

import { ObjectId } from 'mongodb';
import { getAIJobsCollection } from './database';
import { logger } from './logger';

export type AIJobType = 'generate' | 'regen';
export type AIJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface AIJobDoc {
  _id?: ObjectId;
  clientId: string;
  type: AIJobType;
  /** Solo para type='regen': sesión a regenerar. */
  sessionId?: string;
  monthNumber: number;
  coachNotes: string;
  status: AIJobStatus;
  attempts: number;
  claimedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Lease: tiempo tras el cual OTRO worker puede reclamar un job 'running'.
// Debe ser MAYOR que la generación típica (FASE 1 ~110s + FASE 2 ~174s +
// FASE 3 ≈ 5 min) para NO robar workers vivos (doble ejecución), pero lo más
// corto posible para reintentar rápido tras la muerte del worker en Vercel
// (corte a 300s). 6 min logra ambos: un worker sano de ≤5 min nunca se roba;
// uno muerto a los 300s se reintenta ~1 min después (6 min desde el claim),
// dentro de la ventana de polling de 10 min del frontend.
export const JOB_LEASE_MS = 6 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

const log = (clientId: string, message: string, extra?: Record<string, unknown>) =>
  logger.info('AI', `[${clientId}] ${message}`, extra);

/**
 * Crea un job para el cliente, salvo que ya exista uno activo
 * (pending/running con lease vivo) → entonces devuelve el existente
 * (idempotencia ante dobles clics del frontend).
 */
export async function enqueueAIJob(params: {
  clientId: string;
  type?: AIJobType;
  sessionId?: string;
  monthNumber: number;
  coachNotes?: string;
}): Promise<AIJobDoc> {
  const { clientId, monthNumber, coachNotes = '', type = 'generate', sessionId } = params;
  const coll = await getAIJobsCollection();

  // Índice único parcial: a lo sumo UN job activo por cliente.
  // Los jobs terminados (done/failed) no cuentan → permiten historial.
  try {
    await coll.createIndex(
      { clientId: 1 },
      { unique: true, partialFilterExpression: { status: { $in: ['pending', 'running'] } } }
    );
  } catch (e) {
    logger.warn('AI', `No se pudo crear índice único (${(e as Error)?.message})`);
  }

  const now = new Date();
  const doc: AIJobDoc = {
    clientId,
    type,
    ...(sessionId ? { sessionId } : {}),
    monthNumber,
    coachNotes,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await coll.insertOne(doc);
    log(clientId, 'Job encolado', { jobId: res.insertedId.toString(), monthNumber });
    return { ...doc, _id: res.insertedId };
  } catch (e: any) {
    // E11000: ya existe un job activo → reutilizarlo (idempotente),
    // salvo que sea un ZOMBIE (attempts agotados): se abandona y se
    // crea uno nuevo, para que un job muerto no bloquee nuevas peticiones.
    if (e?.code === 11000) {
      const active = await coll.findOne({ clientId, status: { $in: ['pending', 'running'] } });
      if (active) {
        const activeJob = active as AIJobDoc;
        if (activeJob.attempts >= MAX_ATTEMPTS) {
          await coll.updateOne(
            { _id: activeJob._id },
            { $set: { status: 'failed', error: 'Abandonado: superó MAX_ATTEMPTS', updatedAt: now } }
          );
          logger.warn('AI', `[${clientId}] Job zombie abandonado (attempts=${activeJob.attempts}), creando uno nuevo`);
        } else {
          log(clientId, 'Job activo existente reutilizado', {
            jobId: activeJob._id?.toString(),
            status: activeJob.status,
            attempts: activeJob.attempts,
          });
          return activeJob;
        }
      }
    }
    // Reintentar el insert (el zombie ya no ocupa el índice único)
    const res2 = await coll.insertOne({ ...doc, createdAt: now, updatedAt: now });
    log(clientId, 'Job encolado (tras abandonar zombie)', { jobId: res2.insertedId.toString() });
    return { ...doc, _id: res2.insertedId };
  }
}

/**
 * Reclama atómicamente un job pendiente (o uno 'running' cuyo lease expiró)
 * para ejecutarlo. Devuelve null si no hay nada que ejecutar.
 * Incrementa attempts en cada reclamo; tras MAX_ATTEMPTS no se reclama más.
 */
export async function claimAIJob(clientId: string): Promise<AIJobDoc | null> {
  const coll = await getAIJobsCollection();
  const now = new Date();
  const leaseDeadline = new Date(now.getTime() - JOB_LEASE_MS);

  // 1. Job pendiente (caso normal)
  const pending = await coll.findOneAndUpdate(
    {
      clientId,
      status: 'pending',
      attempts: { $lt: MAX_ATTEMPTS },
    },
    {
      $set: { status: 'running', claimedAt: now, updatedAt: now },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' }
  );
  if (pending) {
    log(clientId, 'Job reclamado (pending)', { jobId: pending._id?.toString(), attempts: pending.attempts });
    return pending as AIJobDoc;
  }

  // 2. Job 'running' con lease vencido (el worker anterior murió) → reintento
  const expired = await coll.findOneAndUpdate(
    {
      clientId,
      status: 'running',
      claimedAt: { $lt: leaseDeadline },
      attempts: { $lt: MAX_ATTEMPTS },
    },
    {
      $set: { status: 'running', claimedAt: now, updatedAt: now },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' }
  );
  if (expired) {
    log(clientId, 'Job reclamado (lease vencido, reintento)', {
      jobId: expired._id?.toString(),
      attempts: expired.attempts,
    });
    return expired as AIJobDoc;
  }

  // 3. Job 'running' con lease vencido y attempts AGOTADOS → zombie:
  //    abandonarlo (failed) para que no bloquee y quede diagnosticable.
  await coll.updateOne(
    {
      clientId,
      status: 'running',
      claimedAt: { $lt: leaseDeadline },
      attempts: { $gte: MAX_ATTEMPTS },
    },
    { $set: { status: 'failed', error: 'Abandonado: superó MAX_ATTEMPTS', updatedAt: now } }
  );

  return null;
}

export async function completeAIJob(jobId: ObjectId | string): Promise<void> {
  const coll = await getAIJobsCollection();
  await coll.updateOne(
    { _id: typeof jobId === 'string' ? new ObjectId(jobId) : jobId },
    { $set: { status: 'done', updatedAt: new Date() } }
  );
  logger.info('AI', `[job ${jobId}] Completado`);
}

/** Vuelve a dejar el job en 'pending' tras un fallo recuperable (reintento en el próximo poll). */
export async function requeueAIJob(jobId: ObjectId | string): Promise<void> {
  const coll = await getAIJobsCollection();
  await coll.updateOne(
    { _id: typeof jobId === 'string' ? new ObjectId(jobId) : jobId },
    { $set: { status: 'pending', claimedAt: undefined, updatedAt: new Date() } }
  );
  logger.info('AI', `[job ${jobId}] Re-encolado (reintento)`);
}

export async function failAIJob(jobId: ObjectId | string, message: string): Promise<void> {
  const coll = await getAIJobsCollection();
  await coll.updateOne(
    { _id: typeof jobId === 'string' ? new ObjectId(jobId) : jobId },
    { $set: { status: 'failed', error: message, updatedAt: new Date() } }
  );
  logger.error('AI', `[job ${jobId}] Falló: ${message}`);
}

/** Estado del job activo para el cliente (o null). Útil para diagnósticos. */
export async function getActiveAIJob(clientId: string): Promise<AIJobDoc | null> {
  const coll = await getAIJobsCollection();
  return (await coll.findOne({ clientId, status: { $in: ['pending', 'running'] } })) as AIJobDoc | null;
}
