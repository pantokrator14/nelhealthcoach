/**
 * TEST: El POST/PUT de IA limpia el generationError ANTERIOR al encolar.
 *
 * Contexto (bug de producción 2026-09-03/04): un error de generación viejo
 * quedaba persistido en aiProgress.generationError y el polling del frontend
 * lo seguía mostrando ("error fantasma") aunque se encolara un job NUEVO.
 * Fix: POST y PUT (regen) hacen $unset de aiProgress.generationError al
 * encolar. Este test verifica ese comportamiento.
 *
 * Correr: cd apps/api && npx tsx tests/error-cleanup.test.ts
 */
import 'dotenv/config';
import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';
import { POST } from '../src/app/api/clients/[id]/ai/route';
import { connectDB, registerClientWithJobs, runCleanup, authedRequest, coachToken } from './helpers';

let failures = 0, passes = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passes++; console.log(`  ✅ ${name}`); }
  else { failures++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string) { console.log(`\n═══ ${title} ═══`); }

async function main() {
  const { db } = await connectDB();
  const coachId = new ObjectId().toString();
  const token = coachToken(coachId);

  // Cliente con un generationError VIEJO persistido (como el bug de prod)
  const client = {
    _id: new ObjectId(),
    coachId,
    name: 'Error Cleanup Test',
    personalData: { name: 'Error Cleanup Test', language: 'es' },
    medicalData: { documents: [] },
    aiProgress: {
      currentSessionId: 'session_vieja',
      sessions: [],
      overallProgress: 0,
      generationError: {
        message: 'Fase 1 fallida: El LLM no devolvió un JSON parseable (error viejo del día anterior)',
        timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000), // ayer
      },
    },
  };
  await db.collection('healthforms').insertOne(client as any);
  registerClientWithJobs(client._id.toString());
  const clientId = client._id.toString();

  section('1. POST encola y limpia generationError viejo');
  const res = await POST(
    authedRequest(`http://x/api/clients/${clientId}/ai`, 'POST', token, { monthNumber: 1 }),
    { params: Promise.resolve({ id: clientId }) }
  );
  check('POST responde 202', res.status === 202, `status=${res.status}`);

  const stored = await db.collection('healthforms').findOne({ _id: client._id });
  check('generationError ANTERIOR eliminado de la DB', !stored?.aiProgress?.generationError,
    JSON.stringify(stored?.aiProgress?.generationError));

  // El job quedó encolado (pending) — limpiar para no dejar basura
  await db.collection('ai_jobs').deleteMany({ clientId });
}

main()
  .catch((e) => { console.error('💥 Error cleanup test falló:', e); failures++; })
  .finally(async () => {
    await runCleanup();
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`🎉 ERROR-CLEANUP: ${passes} checks pasaron, ${failures} fallaron`);
    console.log(`══════════════════════════════════════════════════════════`);
    process.exit(failures > 0 ? 1 : 0);
  });
