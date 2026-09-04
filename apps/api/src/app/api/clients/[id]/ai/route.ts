// apps/api/src/app/api/clients/[id]/ai/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getHealthFormsCollection, getMedicalDocumentCacheCollection, connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { decrypt, encrypt, isEncrypted, safeDecrypt } from '@/app/lib/encryption';
import { AIService } from '@/app/lib/ai-service';
import { ChecklistItem, AIRecommendationSession, ClientAIProgress, GenerationError } from '../../../../../../../../packages/types/src/healthForm';
import { EmailService } from '@/app/lib/email-service';
import { generateCompositeRecommendation, CompositeOutputWithIds, generateShoppingListFromWeeklyPlan } from '@/app/lib/composite-recommendation';
import { translateSessionContent, detectLanguage, normalizeClientLang, encryptSessionFields, defaultLLM, SUPPORTED_LANGS, LANG_LABELS, SupportedLang } from '@/app/lib/recommendation-translator';
import { enqueueAIJob, claimAIJob, completeAIJob, failAIJob, requeueAIJob, MAX_ATTEMPTS } from '@/app/lib/ai-job-queue';
import { sendTextToGemini } from '@/app/lib/agents/utils/llm';
import { extractTextFromBuffer } from '@/app/lib/document-extractor';
import { getPresignedUrlForAnalysis } from '@/app/lib/s3';
import Coach from '@/app/models/Coach';
import Recipe from '@/app/models/Recipe';
import Exercise from '@/app/models/Exercise';
import { apiHandler } from '@/app/lib/apiHandler';

// El pipeline de generación de IA toma ~60-240s con DeepSeek (medido en E2E
// reales: 170s generate, 239s regen). El POST/PUT ya NO ejecuta el pipeline:
// solo encola y responde 202; el worker-on-poll corre en el GET con reintentos
// (lease 6 min, máx 3 intentos) si un request muere.
// 300s: MÁXIMO permitido por Vercel en el plan Hobby (1-300). Valores > 300
// hacen FALLAR el build ("Builder returned invalid maxDuration").
export const maxDuration = 300;

/** Verifica que el coach autenticado tenga acceso al cliente (admin o coach asignado) */
async function authorizeCoachForClient(request: NextRequest, clientId: string) {
  let auth;
  try {
    auth = requireCoachAuth(request);
  } catch {
    throw { status: 401, message: 'No autorizado' };
  }
  const healthForms = await getHealthFormsCollection();
  const client = await healthForms.findOne(
    { _id: new ObjectId(clientId) },
    { projection: { coachId: 1 } }
  );
  if (!client) {
    throw { status: 404, message: 'Cliente no encontrado' };
  }
  if (auth.role !== 'admin' && client.coachId !== auth.coachId) {
    throw { status: 403, message: 'No tienes permiso para acceder a este cliente' };
  }
  return auth;
}

function decryptAISessionCompletely(session: any): any {
  try {
    const decrypted = {
      ...session,
      summary: safeDecrypt(session.summary),
      vision: safeDecrypt(session.vision),
      medicalSummary: safeDecrypt(session.medicalSummary) || '',
      medicalComparativeAnalysis: safeDecrypt(session.medicalComparativeAnalysis) || '',
      structuredMedicalAnalysis: session.structuredMedicalAnalysis ? {
        ...session.structuredMedicalAnalysis,
        exams: session.structuredMedicalAnalysis.exams?.map((exam: any) => ({
          ...exam,
          intro: safeDecrypt(exam.intro),
          analysis: safeDecrypt(exam.analysis),
          table: exam.table?.map((row: any) => ({
            ...row,
            biomarcador: safeDecrypt(row.biomarcador),
            valor: safeDecrypt(row.valor),
            rango_normal: safeDecrypt(row.rango_normal),
            estado: safeDecrypt(row.estado),
          })) || [],
        })) || [],
        supplements: session.structuredMedicalAnalysis.supplements?.map((supp: any) => ({
          ...supp,
          name: safeDecrypt(supp.name),
          dosage: safeDecrypt(supp.dosage),
          timing: safeDecrypt(supp.timing),
          rationale: safeDecrypt(supp.rationale),
          contraindications: supp.contraindications ? safeDecrypt(supp.contraindications) : undefined,
        })) || [],
      } : { exams: [], supplements: [] },
      weeks: session.weeks?.map((week: any) => ({
        weekNumber: week.weekNumber,
        nutrition: {
          focus: safeDecrypt(week.nutrition.focus),
          shoppingList: week.nutrition.shoppingList?.map((item: any) => ({
            item: safeDecrypt(item.item),
            quantity: safeDecrypt(item.quantity),
            priority: item.priority
          })) || []
        },
        exercise: {
          focus: safeDecrypt(week.exercise.focus),
          equipment: week.exercise.equipment?.map((eq: string) => safeDecrypt(eq)) || [],
          intro: week.exercise.intro ? safeDecrypt(week.exercise.intro) : undefined,
        },
        habits: {
          trackingMethod: week.habits.trackingMethod ? safeDecrypt(week.habits.trackingMethod) : undefined,
          motivationTip: week.habits.motivationTip ? safeDecrypt(week.habits.motivationTip) : undefined
        }
      })) || [],
      checklist: session.checklist?.map((item: any) => ({
        ...item,
        description: safeDecrypt(item.description),
        details: item.details ? {
          ...item.details,
          recipe: item.details.recipe ? {
            ...item.details.recipe,
            ingredients: item.details.recipe.ingredients?.map((ing: any) => ({
              name: safeDecrypt(ing.name),
              quantity: safeDecrypt(ing.quantity),
              notes: ing.notes ? safeDecrypt(ing.notes) : undefined
            })) || [],
            preparation: safeDecrypt(item.details.recipe.preparation),
            tips: item.details.recipe.tips ? safeDecrypt(item.details.recipe.tips) : undefined
          } : undefined,
          frequency: item.details.frequency ? safeDecrypt(item.details.frequency) : undefined,
          duration: item.details.duration ? safeDecrypt(item.details.duration) : undefined,
          equipment: item.details.equipment?.map((eq: string) => safeDecrypt(eq))
        } : undefined
      })) || []
    };
    return decrypted;
  } catch (error) {
    console.error('❌ Error desencriptando sesión completa:', error);
    logger.error('AI', 'Error desencriptando sesión completa', error);

    // Corrección: Crear error correctamente
    const errorObj = new Error('Error desencriptando sesión completa');
    logger.error('AI', 'Error desencriptando sesión completa', errorObj);

    // Fallback: intentar desencriptar lo básico
    return {
      ...session,
      summary: safeDecrypt(session.summary) || 'Error desencriptando',
      vision: safeDecrypt(session.vision) || 'Error desencriptando',
      structuredMedicalAnalysis: session.structuredMedicalAnalysis ? {
        ...session.structuredMedicalAnalysis,
        exams: session.structuredMedicalAnalysis.exams?.map((exam: any) => ({
          ...exam,
          intro: safeDecrypt(exam.intro) || exam.intro,
          analysis: safeDecrypt(exam.analysis) || exam.analysis,
          table: exam.table?.map((row: any) => ({
            ...row,
            biomarcador: safeDecrypt(row.biomarcador) || row.biomarcador,
            valor: safeDecrypt(row.valor) || row.valor,
            rango_normal: safeDecrypt(row.rango_normal) || row.rango_normal,
            estado: safeDecrypt(row.estado) || row.estado,
          })) || [],
        })) || [],
        supplements: session.structuredMedicalAnalysis.supplements?.map((supp: any) => ({
          ...supp,
          name: safeDecrypt(supp.name) || supp.name,
          dosage: safeDecrypt(supp.dosage) || supp.dosage,
          timing: safeDecrypt(supp.timing) || supp.timing,
          rationale: safeDecrypt(supp.rationale) || supp.rationale,
          contraindications: supp.contraindications ? safeDecrypt(supp.contraindications) || supp.contraindications : undefined,
        })) || [],
      } : { exams: [], supplements: [] },
      weeks: [],
      checklist: []
    };
  }
}

// GET: Obtener recomendaciones de IA existentes
async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = crypto.randomUUID();

  const loggerWithContext = logger.withContext({
    requestId,
    clientId: id,
    endpoint: `/api/clients/${id}/ai`,
    method: 'GET'
  });

  return loggerWithContext.time('AI', 'Obtener recomendaciones IA', async () => {
    try {
      loggerWithContext.info('AI', 'Iniciando obtención de progreso de IA');

      // Autenticación + ownership check
      const auth = await authorizeCoachForClient(request, id);

      const healthForms = await getHealthFormsCollection();
      let client = await healthForms.findOne({ _id: new ObjectId(id) });

      if (!client) {
        loggerWithContext.warn('AI', 'Cliente no encontrado');
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado' },
          { status: 404 }
        );
      }

      // ── Worker-on-poll (cola propia en Mongo, sin Inngest) ──────────
      // El POST encola y responde 202; el polling del frontend (este GET)
      // reclama el job ATOMICAMENTE y ejecuta el pipeline completo aquí.
      // Si el request muere (timeout de Vercel), el lease caduca y otro
      // poll reintenta (hasta MAX_ATTEMPTS). El frontend poll-ea cada 10s
      // viendo `aiProgress.sessions` hasta que aparezcan o haya error.
      const claimedJob = await claimAIJob(id);
      if (claimedJob) {
        loggerWithContext.info('AI', '🚀 Worker: job reclamado, ejecutando generación', {
          jobId: claimedJob._id?.toString(),
          type: claimedJob.type,
          attempts: claimedJob.attempts,
        });
        try {
          let workerResult: { sessionId: string; generationError: any } | undefined;
          if (claimedJob.type === 'regen') {
            // Regeneración: la sesión vieja se reemplaza por una nueva
            // (regenerateSession lanza si la sesión no está en 'draft').
            const ok = await regenerateSession(
              id,
              claimedJob.sessionId || '',
              claimedJob.coachNotes,
              requestId
            );
            if (!ok) throw new Error('La regeneración no pudo completarse');
            workerResult = { sessionId: claimedJob.sessionId || '', generationError: null };
          } else {
            workerResult = await executeGenerationForClient(
              client,
              { monthNumber: claimedJob.monthNumber, coachNotes: claimedJob.coachNotes },
              requestId
            );
          }
          await completeAIJob(claimedJob._id!);
          loggerWithContext.info('AI', '✅ Worker: generación completada', {
            sessionId: workerResult?.sessionId,
            type: claimedJob.type,
            hadGenerationError: !!workerResult?.generationError,
          });
        } catch (genError: any) {
          const errMsg = genError?.message || 'Error desconocido generando recomendaciones';
          loggerWithContext.error('AI', '❌ Worker: generación falló', genError);

          // ── CARRERA ENTRE WORKERS ──
          // Si OTRO worker ya creó una sesión después de que este reclamó el
          // job (lease vencido → robo), este worker es el PERDEDOR: su error
          // no debe persistirse encima de la sesión buena del ganador
          // (bug visto en prod: error con timestamp posterior a la sesión OK).
          const freshCheck = await healthForms.findOne(
            { _id: new ObjectId(id) },
            { projection: { 'aiProgress.sessions': 1 } }
          );
          const claimedAtMs = claimedJob.claimedAt ? new Date(claimedJob.claimedAt).getTime() : 0;
          const loser =
            claimedAtMs > 0 &&
            (freshCheck?.aiProgress?.sessions || []).some((s: any) => {
              const createdMs = s.createdAt ? new Date(s.createdAt).getTime() : 0;
              return createdMs >= claimedAtMs;
            });

          if (loser) {
            // Otro worker ganó: ignorar este error y cerrar el job como done
            // (el objetivo — tener recomendaciones — ya se cumplió).
            loggerWithContext.warn('AI', '⚠️ Worker perdedor: ya existe sesión creada tras mi claim — error ignorado', {
              jobId: claimedJob._id?.toString(),
              error: errMsg,
            });
            await completeAIJob(claimedJob._id!);
          } else if (claimedJob.attempts! >= MAX_ATTEMPTS) {
            await failAIJob(claimedJob._id!, errMsg);
            // Persistir el error para que el polling del frontend lo muestre
            // (el GET ya devuelve aiProgress.generationError si existe).
            await healthForms.updateOne(
              { _id: new ObjectId(id) },
              { $set: { 'aiProgress.generationError': { message: errMsg, timestamp: new Date() } } }
            );
          } else {
            // Reintento inmediato en el próximo poll (sin esperar el lease)
            await requeueAIJob(claimedJob._id!);
          }
        }
        // Releer: la generación pudo crear aiProgress/sesiones
        const fresh = await healthForms.findOne({ _id: new ObjectId(id) });
        if (fresh) client = fresh;
      }

      loggerWithContext.debug('AI', 'Cliente encontrado', {
        hasAIProgress: !!client.aiProgress,
        aiProgressKeys: client.aiProgress ? Object.keys(client.aiProgress) : []
      });

      // Devolver progreso de IA si existe
      const aiProgress = client.aiProgress;

      if (!aiProgress) {
        loggerWithContext.info('AI', 'Cliente sin progreso de IA');
        return NextResponse.json({
          success: true,
          data: {
            hasAIProgress: false,
            message: 'No hay recomendaciones de IA generadas aún'
          }
        });
      }

      // Si hay un error de generación pendiente (Inngest falló), incluirlo
      const generationError = aiProgress.generationError || null;
      if (generationError) {
        loggerWithContext.warn('AI', 'Error de generación pendiente encontrado', {
          errorMessage: generationError.message,
          timestamp: generationError.timestamp,
        });
      }

      // Si solo hay error y no sesiones, devolver el error sin intentar desencriptar
      if (!aiProgress.sessions || aiProgress.sessions.length === 0) {
        return NextResponse.json({
          success: true,
          data: {
            hasAIProgress: true,
            aiProgress: {
              sessions: [],
              generationError,
              overallProgress: aiProgress.overallProgress || 0,
            },
            generationError,
          },
          requestId,
        });
      }

      loggerWithContext.info('AI', 'Progreso de IA encontrado', {
        sessionCount: aiProgress.sessions?.length || 0,
        overallProgress: aiProgress.overallProgress,
        currentSessionId: aiProgress.currentSessionId
      });

      // Desencriptar sesiones si es necesario
      const decryptedSessions = aiProgress.sessions?.map((session: any) =>
        decryptAISessionCompletely(session)
      ) || [];

      loggerWithContext.info('AI', 'Sesiones completamente desencriptadas', {
        sessionCount: decryptedSessions.length
      });

      return NextResponse.json({
        success: true,
        data: {
          hasAIProgress: true,
          aiProgress: {
            ...aiProgress,
            sessions: decryptedSessions,  // ✅ Ahora completamente desencriptadas
          },
          generationError,
        },
        requestId
      });

    } catch (error: any) {
      // Si es un error estructurado (auth/ownership), devolver su status específico
      if (error?.status) {
        return NextResponse.json(
          { success: false, message: error.message || 'Error' },
          { status: error.status }
        );
      }

      loggerWithContext.error('AI', 'Error obteniendo recomendaciones IA', error);

      return NextResponse.json(
        {
          success: false,
          message: 'Error interno del servidor',
          requestId,
          ...(process.env.NODE_ENV === 'development' && {
            error: error.message
          })
        },
        { status: 500 }
      );
    }
  });
}

export const GET = apiHandler(getHandler);

/**
 * POST: Generar nuevas recomendaciones de IA
 */
async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = crypto.randomUUID();

  const loggerWithContext = logger.withContext({
    requestId,
    clientId: id,
    endpoint: `/api/clients/${id}/ai`,
    method: 'POST'
  });

  return loggerWithContext.time('AI', 'Generar recomendaciones IA', async () => {
    try {
      loggerWithContext.info('AI', 'Iniciando generación de recomendaciones IA');

      // Autenticación + ownership check
      const auth = await authorizeCoachForClient(request, id);

      let body;
      try {
        body = await request.json();
        loggerWithContext.debug('AI', 'Cuerpo de la solicitud recibido', {
          bodyKeys: Object.keys(body),
          monthNumber: body.monthNumber,
          hasCoachNotes: !!body.coachNotes
        });
      } catch (error) {
        loggerWithContext.error('AI', 'Error parseando JSON de la solicitud', error as Error);
        return NextResponse.json(
          { success: false, message: 'Cuerpo de solicitud inválido' },
          { status: 400 }
        );
      }

      const { monthNumber = 1, coachNotes = '' } = body;

      loggerWithContext.info('AI', 'Parámetros procesados', {
        monthNumber,
        coachNotesLength: coachNotes.length
      });

      const healthForms = await getHealthFormsCollection();
      const client = await healthForms.findOne({ _id: new ObjectId(id) });

      if (!client) {
        loggerWithContext.warn('AI', 'Cliente no encontrado');
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado' },
          { status: 404 }
        );
      }

      // ── COLA PROPIA (sin Inngest): encolar y responder 202 ──────────
      // El pipeline completo (prepareAIInput → composite → FASE 4 → cifrar)
      // lo ejecuta el worker-on-poll del GET al reclamar este job.
      // El frontend ya maneja { status: 'queued', jobId } → activa polling.
      const job = await enqueueAIJob({ clientId: id, monthNumber, coachNotes });

      // Limpiar el generationError ANTERIOR (si lo hay): sin esto, el polling
      // del frontend seguiría mostrando un error viejo de un intento previo
      // mientras el job nuevo corre (error fantasma — bug reportado en prod).
      await healthForms.updateOne(
        { _id: new ObjectId(id) },
        { $unset: { 'aiProgress.generationError': '' } }
      );

      loggerWithContext.info('AI', 'Generación encolada', {
        jobId: job._id?.toString(),
        monthNumber,
      });

      return NextResponse.json({
        success: true,
        data: {
          status: 'queued',
          jobId: job._id?.toString(),
          clientId: id,
          requestId,
          monthNumber,
        },
      }, { status: 202 });
    } catch (error: any) {
      // Si es un error estructurado (auth/ownership), devolver su status específico
      if (error?.status) {
        return NextResponse.json(
          { success: false, message: error.message || 'Error' },
          { status: error.status }
        );
      }

      const errorObj = error instanceof Error ? error : new Error('Unknown error');
      loggerWithContext.error('AI', 'Error generando recomendaciones IA', errorObj);

      return NextResponse.json(
        {
          success: false,
          message: 'Error generando recomendaciones',
          requestId,
          ...(process.env.NODE_ENV === 'development' && {
            error: errorObj.message
          })
        },
        { status: 500 }
      );
    }
  });
}

export const POST = apiHandler(postHandler);

/**
 * EJECUTA el pipeline completo de generación (prepareAIInput → composite →
 * checklist/weeks → FASE 4 traducción → cifrado → persistir aiProgress).
 * Lo usa el worker-on-poll del GET cuando reclama un job de la cola propia.
 * Lanza error si la generación falla (el caller decide fail o requeue).
 */
async function executeGenerationForClient(
  client: any,
  params: { monthNumber: number; coachNotes: string },
  requestId: string
): Promise<{ sessionId: string; generationError: any }> {
  const clientId = client._id.toString();
  const loggerWithContext = logger.withContext({
    requestId,
    clientId,
    endpoint: '/api/clients/[id]/ai (queue-worker)',
    method: 'EXECUTE',
  });

  const { monthNumber, coachNotes } = params;

  const healthForms = await getHealthFormsCollection();

      // 1. Preparar datos para la IA
      const aiInput = await prepareAIInput(client, requestId, clientId);

      // 2. Agregar notas del coach si las hay
      if (coachNotes) {
        aiInput.coachNotes = coachNotes;
      }

      // 3. Agregar sesiones anteriores si existen
      if (client.aiProgress?.sessions) {
        aiInput.previousSessions = client.aiProgress.sessions;
        aiInput.currentProgress = client.aiProgress;
      }

      // 4. Generar recomendaciones con prompt compuesto (DIRECTO, sin Inngest)
      loggerWithContext.info('AI', 'Generando recomendaciones con prompt compuesto');

      const {
        mentalHealth,
        healthAssessment,
        documents: processedDocuments,
      } = aiInput;

      const compositeResult = await generateCompositeRecommendation({
        personalData: aiInput.personalData || {},
        medicalData: aiInput.medicalData || {},
        healthAssessment: healthAssessment || {},
        mentalHealth: mentalHealth || {},
        processedDocuments: (processedDocuments || []).map((d: { title?: string; content?: string; documentType?: string; confidence?: number }) => ({
          title: d.title || '',
          content: d.content || '',
          documentType: d.documentType || 'other',
          confidence: d.confidence || 0,
        })),
        previousSessions: (aiInput.previousSessions || []) as any,
        coachNotes: aiInput.coachNotes || '',
        monthNumber,
      });

      loggerWithContext.info('AI', 'Recomendaciones generadas exitosamente', {
        weekCount: compositeResult.nutritionPlan?.weeklyPlan?.length || 7,
      });

      // ── FAIL-FAST: Validación de integridad antes de persistir ──
      const hasDocuments = processedDocuments && processedDocuments.length > 0;
      const medExams = compositeResult.clientInsights?.structuredMedicalAnalysis?.exams;
      const medSupps = compositeResult.clientInsights?.structuredMedicalAnalysis?.supplements;
      const nutritionPlan = compositeResult.nutritionPlan?.weeklyPlan;
      const exercisePlan = compositeResult.exercisePlan?.weeklyRoutine;

      if (hasDocuments && (!medExams || medExams.length === 0)) {
        throw new Error('ABORTAR_GUARDADO: La IA devolvió un análisis médico vacío (exams=0) habiendo documentos procesados. No se deben persistir datos corruptos.');
      }
      if (!nutritionPlan || nutritionPlan.length === 0) {
        throw new Error('ABORTAR_GUARDADO: La IA devolvió un plan de nutrición vacío. Componente fallido: Nutrición.');
      }
      if (!exercisePlan || exercisePlan.length === 0) {
        throw new Error('ABORTAR_GUARDADO: La IA devolvió un plan de ejercicios vacío. Componente fallido: Ejercicio.');
      }

      loggerWithContext.info('AI', '✅ Validación de integridad superada', {
        hasMedicalAnalysis: !!medExams && medExams.length > 0,
        examCount: medExams?.length || 0,
        supplementCount: medSupps?.length || 0,
        nutritionDays: nutritionPlan.length,
        exerciseDays: exercisePlan.length,
      });

      // IDs de recetas y ejercicios encontrados en la DB
      const recipeIds: Record<string, string> = compositeResult._recipeIds || {};
      const exerciseIds: Record<string, string> = compositeResult._exerciseIds || {};

      // 6. Construir sesión y guardar en DB
      // SEC-15: sessionId con entropía (randomUUID) — antes era predecible
      // (timestamp + mes), lo que permitía IDOR en el PDF share-by-link.
      // Las sesiones existentes con formato viejo siguen siendo encontrables
      // (búsqueda por igualdad exacta, sin parsing del formato).
      const sessionId = `session_${crypto.randomUUID()}`;

      // Construir checklist items desde el plan semanal
      const checklistItems: ChecklistItem[] = [];
      const dayTranslations: Record<string, string> = { Monday: 'Lunes', Tuesday: 'Martes', Wednesday: 'Miércoles', Thursday: 'Jueves', Friday: 'Viernes', Saturday: 'Sábado', Sunday: 'Domingo' };

      // Items de nutrición (desayuno/almuerzo/cena para cada día)
      if (compositeResult.nutritionPlan?.weeklyPlan) {
        for (const day of compositeResult.nutritionPlan.weeklyPlan) {
          const dayName = dayTranslations[day.day] || day.day;
          for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
            const mealName = meal === 'breakfast' ? 'Desayuno' : meal === 'lunch' ? 'Almuerzo' : 'Cena';
            const recipe = day[meal];
            if (recipe) {
              const recipeId = recipeIds[recipe] || '';
              checklistItems.push({
                id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                description: `${dayName} ${mealName}: ${recipe}`,
                completed: false,
                weekNumber: 1,
                category: 'nutrition',
              type: mealName.toLowerCase(),
              recipeId,
              details: recipeId ? undefined : { recipe: { ingredients: [], preparation: recipe } },
              isRecurring: false,
            } as ChecklistItem);
          }
        }
      }
    }

    // Items de ejercicios
      if (compositeResult.exercisePlan?.weeklyRoutine) {
        for (const day of compositeResult.exercisePlan.weeklyRoutine) {
          const dayName = dayTranslations[day.day] || day.day;
          if (day.exercises) {
            for (const ex of day.exercises) {
              const exerciseId = exerciseIds[ex.name] || '';
              checklistItems.push({
                id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                description: `${dayName}: ${ex.name}`,
                completed: false,
                weekNumber: 1,
                category: 'exercise',
                type: 'ejercicio',
                recipeId: exerciseId,
                details: {
                  duration: `${ex.sets || 3} series x ${ex.repetitions || '12'} reps`,
                  equipment: compositeResult.exercisePlan?.equipment,
                  frequency: day.day,
                },
                isRecurring: false,


              });
            }
          }
        }
      }

      // Items de hábitos (adoptar)
      if (compositeResult.habitPlan?.toAdopt) {
        for (const h of compositeResult.habitPlan.toAdopt) {
          checklistItems.push({
            id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            description: h.habit || 'Nuevo hábito',
            completed: false,
            weekNumber: 1,
            category: 'habit',
            type: 'toAdopt',
            isRecurring: true,
            details: { trigger: h.trigger || undefined },
          } as ChecklistItem);
        }
      }
      if (compositeResult.habitPlan?.toEliminate) {
        for (const h of compositeResult.habitPlan.toEliminate) {
          checklistItems.push({
            id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            description: h.habit ? (h.replacement ? `${h.habit} → ${h.replacement}` : h.habit) : 'Eliminar hábito',
            completed: false,
            weekNumber: 1,
            category: 'habit',
            type: 'toEliminate',
            isRecurring: true,
          } as ChecklistItem);
        }
      }

      // Items de alternativas
      if (compositeResult.alternatives) {
        for (const alt of compositeResult.alternatives) {
          const mealLabel = alt.meal || 'comida';
          const recipeLabel = alt.recipe || 'receta';
          const altRecipeId = compositeResult._recipeIds?.[recipeLabel] || '';
          checklistItems.push({
            id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            description: `🔄 Alternativa - ${mealLabel}: ${recipeLabel}`,
            completed: false,
            weekNumber: 1,
            category: 'nutrition',
            type: 'alternativa',
            recipeId: altRecipeId,
            notes: alt.description || '',
            isRecurring: false,
          });
        }
      }

      // Construir weeks[] con los datos desencriptados (EN PLANO; se cifran tras la FASE 4)
      const shopList = Array.isArray(compositeResult.nutritionPlan?.shoppingList)
        ? compositeResult.nutritionPlan!.shoppingList
        : [];
      const weeks = [{
        weekNumber: 1,
        nutrition: {
          focus: `Plan de comidas: ${compositeResult.nutritionPlan?.weeklyPlan?.length || 7} días, 3 comidas al día`,
          shoppingList: shopList.filter((item: { item?: string; quantity?: string }) => item?.item && item?.quantity).map((item: { item?: string; quantity?: string; priority?: string }) => ({
            item: item.item!,
            quantity: item.quantity!,
            priority: item.priority || 'medium',
          })),
        },
        exercise: {
          focus: compositeResult.exercisePlan?.notes || 'Rutina semanal',
          equipment: (compositeResult.exercisePlan?.equipment || []).map((eq: string) => eq || ''),
        },
        habits: {
          trackingMethod: compositeResult.habitPlan?.trackingMethod || undefined,
          motivationTip: compositeResult.habitPlan?.motivationTip || undefined,
        },
      }];

      const generationError = aiInput.failedDocumentAnalyses.length > 0 ? {
        message: `Algunos documentos no pudieron ser analizados debido a alta demanda o error del servicio de IA (HTTP 503/404): ${aiInput.failedDocumentAnalyses.map((e: any) => e.documentName).join(', ')}. Se generaron las recomendaciones con el resto de la información disponible de formularios y otros documentos.`,
        timestamp: new Date(),
      } : null;

      // ── Extraer la estructura médica directamente del orquestador ──
      const extractedStructured = compositeResult.clientInsights?.structuredMedicalAnalysis || { exams: [], supplements: [] };

      loggerWithContext.debug('AI', '🏥 [VERIFICACIÓN] Estructura médica a guardar', {
        examCount: extractedStructured.exams?.length || 0,
        supplementCount: extractedStructured.supplements?.length || 0,
        structuredMedicalAnalysis: extractedStructured,
      });

      // ── Limpieza de duplicados en checklist antes de persistir ──
      const uniqueChecklist = Array.from(
        new Map(checklistItems.map(item => [item.description, item])).values()
      ) as ChecklistItem[];

      loggerWithContext.info('AI', 'Checklist deduplicado', {
        originalCount: checklistItems.length,
        uniqueCount: uniqueChecklist.length,
        removedDuplicates: checklistItems.length - uniqueChecklist.length,
      });

      // Sesión en PLANO (sin cifrar). La FASE 4 la traduce al idioma del
      // cliente si hace falta, y encryptSessionFields() cifra después.
      const sessionPlain = {
        sessionId,
        monthNumber,
        totalWeeks: 4,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'draft',
        // Indicador para la UI: 0 = el cliente no subió documentos médicos,
        // > 0 = había documentos al generar (permite diferenciar "sin documentos"
        // de "error al procesar" en el frontend).
        documentCount: (processedDocuments || []).length,
        summary: compositeResult.clientInsights?.summary || '',
        vision: compositeResult.clientInsights?.vision || compositeResult.clientInsights?.summary || '',
        medicalSummary: compositeResult.clientInsights?.medicalSummary || aiInput.extractedMedicalSummary || '',
        medicalComparativeAnalysis: compositeResult.clientInsights?.medicalComparativeAnalysis || '',
        labResults: aiInput.allLabResults && aiInput.allLabResults.length > 0 
          ? aiInput.allLabResults 
          : (compositeResult.clientInsights?.labResults || []),
        structuredMedicalAnalysis: extractedStructured,
        baselineMetrics: {
          currentLifestyle: compositeResult.clientInsights?.keyRisks || [],
          targetLifestyle: compositeResult.clientInsights?.targetImprovements || [],
        },
        weeks,
        checklist: uniqueChecklist,
        regenerationCount: 0,
        regenerationHistory: [],
      };

      // ── FASE 4: TRADUCCIÓN DINÁMICA al idioma del cliente ──
      // El pipeline genera SIEMPRE en español (los títulos del plan deben
      // matchear la DB). Si el cliente habla otro idioma, traducimos TODO el
      // contenido visible de la sesión: resúmenes, análisis médico, semanas,
      // lista de compras, hábitos y checklist (las recetas/exercicios de la DB
      // se traducen aparte, en el PDF, según su idioma real de origen).
      const targetLang = normalizeClientLang(aiInput.personalData?.language);
      let translationMeta: { targetLang: SupportedLang; sourceLang: SupportedLang } | undefined;
      let sessionToEncrypt = sessionPlain;

      if (targetLang !== 'es') {
        const usedRecipeIds = Array.from(new Set(Object.values(recipeIds).filter(Boolean))) as string[];
        const usedExerciseIds = Array.from(new Set(Object.values(exerciseIds).filter(Boolean))) as string[];
        const sourceLang = await detectSessionSourceLang(usedRecipeIds, usedExerciseIds, loggerWithContext);
        translationMeta = { targetLang, sourceLang };
        loggerWithContext.info('AI', '🌍 FASE 4: traduciendo recomendaciones al idioma del cliente', {
          targetLang,
          sourceLang: `${sourceLang} (${LANG_LABELS[sourceLang]})`,
        });
        sessionToEncrypt = await translateSessionContent(
          sessionPlain,
          targetLang,
          LANG_LABELS[sourceLang],
          defaultLLM
        );
      }

      const encryptedSession = encryptSessionFields(sessionToEncrypt, translationMeta);

      const updateData: Record<string, unknown> = {
        $set: {
          updatedAt: new Date(),
          'aiProgress': {
            clientId: clientId,
            currentSessionId: sessionId,
            sessions: [encryptedSession],
            overallProgress: 0,
            lastEvaluation: new Date(),
            nextEvaluation: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            metrics: {
              nutritionAdherence: 0,
              exerciseConsistency: 0,
              habitFormation: 0,
            },
            ...(generationError && { generationError }),
          },
        },
      };

      await healthForms.updateOne(
        { _id: new ObjectId(clientId) },
        updateData
      );

      loggerWithContext.info('AI', 'Recomendaciones guardadas exitosamente', {
        sessionId,
        hasGenerationError: !!generationError,
      });
  return { sessionId, generationError };

}

/**
 * Detecta el idioma de origen del contenido usado en el plan (recetas y
 * ejercicios de la DB). Las recetas pueden haber sido subidas por coaches en
 * CUALQUIER idioma; esto alimenta el banner informativo y el hint del LLM.
 * Sin contenido en DB (plan generado por LLM) → 'es' (idioma del pipeline).
 */
async function detectSessionSourceLang(
  recipeIds: string[],
  exerciseIds: string[],
  logCtx: ReturnType<typeof logger.withContext>
): Promise<SupportedLang> {
  const texts: string[] = [];

  if (recipeIds.length > 0) {
    try {
      const found = await Recipe.find({ _id: { $in: recipeIds.map((r) => new ObjectId(r)) } }).lean();
      for (const r of found as any[]) {
        texts.push(safeDecrypt(r.title) || r.title || '');
        for (const ing of r.ingredients || []) {
          texts.push(safeDecrypt(ing) || ing || '');
        }
      }
      logCtx.debug('AI', 'Recetas cargadas para detectar idioma de origen', {
        count: found.length,
      });
    } catch (err) {
      logCtx.warn('AI', 'Error cargando recetas para detección de idioma', err as Error);
    }
  }

  if (exerciseIds.length > 0) {
    try {
      const found = await Exercise.find({ _id: { $in: exerciseIds.map((e) => new ObjectId(e)) } }).lean();
      for (const ex of found as any[]) {
        texts.push(safeDecrypt(ex.name) || ex.name || '');
        if (ex.description) texts.push(safeDecrypt(ex.description) || ex.description || '');
      }
    } catch (err) {
      logCtx.warn('AI', 'Error cargando ejercicios para detección de idioma', err as Error);
    }
  }

  if (texts.filter((t) => t.trim().length > 0).length === 0) {
    return 'es';
  }
  return detectLanguage(texts);
}

/**
 * Helper function to save and return recommendations (used as fallback).
 */
async function saveAndReturnRecommendations(
  recommendations: Record<string, unknown>,
  healthForms: ReturnType<typeof getHealthFormsCollection> extends Promise<infer T> ? T : never,
  clientId: string,
  monthNumber: number,
  requestId: string,
  loggerWithContext: ReturnType<typeof logger.withContext>,
  client: Record<string, unknown>
): Promise<NextResponse> {
  const updateData: Record<string, unknown> = {
    $set: {
      updatedAt: new Date()
    }
  };

  const aiProgress = client.aiProgress as { sessions?: Array<Record<string, unknown>> } | undefined;
  const sessions = aiProgress?.sessions ?? [];
  const existingSessionIndex = sessions.findIndex((s: Record<string, unknown>) => s.monthNumber === monthNumber);

  if (!aiProgress || existingSessionIndex === -1) {
    (updateData.$set as Record<string, unknown>)['aiProgress'] = {
      clientId,
      currentSessionId: recommendations.sessionId,
      sessions: [recommendations],
      overallProgress: 0,
      lastEvaluation: new Date(),
      nextEvaluation: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      metrics: {
        nutritionAdherence: 0,
        exerciseConsistency: 0,
        habitFormation: 0
      }
    };
  } else {
    const updatedSessions = [...sessions];
    updatedSessions[existingSessionIndex] = recommendations;
    (updateData.$set as Record<string, unknown>)['aiProgress.sessions'] = updatedSessions;
    (updateData.$set as Record<string, unknown>)['aiProgress.currentSessionId'] = recommendations.sessionId;
    (updateData.$set as Record<string, unknown>)['aiProgress.lastEvaluation'] = new Date();
    (updateData.$set as Record<string, unknown>)['aiProgress.nextEvaluation'] = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const collection = await healthForms;
  const result = await collection.updateOne(
    { _id: new ObjectId(clientId) },
    updateData
  );

  if (result.modifiedCount === 0 && result.upsertedCount === 0) {
    throw new Error('No se pudo guardar las recomendaciones en la base de datos');
  }

  return NextResponse.json({
    success: true,
    data: {
      sessionId: recommendations.sessionId,
      monthNumber,
      summary: recommendations.summary,
      vision: recommendations.vision,
      weekCount: (recommendations.weeks as Array<unknown>)?.length ?? 0,
      weeks: recommendations.weeks,
      requestId
    }
  });
}

// PUT: Actualizar checklist o aprobar recomendaciones
async function putHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = crypto.randomUUID();

  const loggerWithContext = logger.withContext({
    requestId,
    clientId: id,
    endpoint: `/api/clients/${id}/ai`,
    method: 'PUT'
  });

  return loggerWithContext.time('AI', 'Actualizar recomendaciones IA', async () => {
    let requestBody = null;

    try {
      loggerWithContext.info('AI', 'Actualizando recomendaciones IA');

      // Autenticación + ownership check
      const auth = await authorizeCoachForClient(request, id);

      requestBody = await request.json();
      console.log('📦 Body recibido en PUT:', requestBody);

      const { action, sessionId, data } = requestBody;

      loggerWithContext.info('AI', 'Parámetros de actualización', {
        action,
        sessionId,
        dataKeys: data ? Object.keys(data) : []
      });

      const healthForms = await getHealthFormsCollection();
      const client = await healthForms.findOne({ _id: new ObjectId(id) });

      if (!client || !client.aiProgress) {
        loggerWithContext.warn('AI', 'Cliente o progreso de IA no encontrado');
        return NextResponse.json(
          { success: false, message: 'Cliente o progreso de IA no encontrado' },
          { status: 404 }
        );
      }

      let operationResult: any;
      let message = '';

      switch (action) {
        case 'update_checklist':
          console.log('🔄 UPDATE_CHECKLIST: Iniciando...', {
            sessionId,
            checklistItemsCount: data?.checklistItems?.length || 0
          });

          // ✅ Directamente retornamos aquí, no necesitamos almacenar el resultado
          const updateChecklistResult = await updateChecklist(id, sessionId, data.checklistItems, requestId);
          return NextResponse.json(updateChecklistResult);

        case 'update_session_fields':
          console.log('📝 UPDATE_SESSION_FIELDS: Iniciando...', {
            sessionId,
            fields: data?.fields ? Object.keys(data.fields) : []
          });
          operationResult = await updateSessionFields(id, sessionId, data?.fields || {}, requestId);
          message = 'Campos de sesión actualizados';
          break;

        case 'approve_session':
          console.log('✅ APPROVE_SESSION: Iniciando...', { sessionId });

          console.log('🔍 DEBUG: Estado antes de aprobar', {
            clientId: id,
            sessionId,
            action: 'approve_session'
          });

           // Depuración rápida
          const debugInfo = await debugSessionStatus(id, sessionId);
          console.log('🔍 DEBUG Session Status:', debugInfo);

          try {
            operationResult = await approveSession(id, sessionId, requestId);

            if (!operationResult) {
              // ✅ CORRECCIÓN: Crear un error correctamente
              const error = new Error('Falló la aprobación de sesión');
              // Agregar propiedades adicionales usando 'as any'
              (error as any).sessionId = sessionId;
              (error as any).possibleReasons = [
                'Sesión no encontrada',
                'Sesión no está en estado draft',
                'Cliente no encontrado'
              ];

              loggerWithContext.error('AI', 'Falló la aprobación de sesión', error);

              return NextResponse.json(
                {
                  success: false,
                  message: 'No se pudo aprobar la sesión. Verifica que la sesión esté en estado "draft".',
                  requestId
                },
                { status: 400 } // Cambia a 400 Bad Request
              );
            }

            message = 'Sesión aprobada exitosamente';
          } catch (error: any) {
            loggerWithContext.error('AI', 'Error en approve_session', error);
            return NextResponse.json(
              {
                success: false,
                message: `Error aprobando sesión: ${error.message}`,
                requestId
              },
              { status: 500 }
            );
          }
          break;

        case 'send_to_client':
          console.log('📤 SEND_TO_CLIENT: Iniciando...', { sessionId });
          operationResult = await sendToClient(id, sessionId, requestId);
          message = 'Recomendaciones enviadas al cliente';
          break;

        case 'regenerate_session': {
          console.log('🔄 REGENERATE_SESSION: Iniciando...', {
            sessionId,
            hasCoachNotes: !!data?.coachNotes,
            notesLength: data?.coachNotes?.length || 0
          });

          // Validación fail-fast: la sesión debe existir y estar en 'draft'
          const targetSession = (client.aiProgress.sessions || []).find(
            (s: any) => s.sessionId === sessionId
          );
          if (!targetSession) {
            return NextResponse.json(
              { success: false, message: 'Sesión no encontrada' },
              { status: 404 }
            );
          }
          if (targetSession.status !== 'draft') {
            return NextResponse.json(
              { success: false, message: `Solo se pueden regenerar sesiones en estado 'draft'. Estado actual: '${targetSession.status}'` },
              { status: 400 }
            );
          }

          // ── COLA PROPIA: encolar la regeneración y responder 202 ──
          // El worker-on-poll del GET ejecuta regenerateSession y reemplaza
          // la sesión; el frontend detecta el cambio de currentSessionId.
          const regenJob = await enqueueAIJob({
            clientId: id,
            type: 'regen',
            sessionId,
            monthNumber: targetSession.monthNumber || 1,
            coachNotes: data?.coachNotes || '',
          });
          // Limpiar generationError anterior (evita error fantasma durante el polling)
          await healthForms.updateOne(
            { _id: new ObjectId(id) },
            { $unset: { 'aiProgress.generationError': '' } }
          );
          console.log('🔁 Regeneración encolada:', regenJob._id?.toString());
          return NextResponse.json({
            success: true,
            data: {
              status: 'queued',
              jobId: regenJob._id?.toString(),
              clientId: id,
              sessionId,
              requestId,
            },
          }, { status: 202 });
        }

        case 'generate_shopping_list':
          console.log('🛒 GENERATE_SHOPPING_LIST: Iniciando...', { sessionId, weekNumber: data?.weekNumber });
          operationResult = await generateShoppingList(id, sessionId, data?.weekNumber, requestId);
          message = 'Lista de compras actualizada';
          break;

        case 'update_weekly_plan':
          console.log('📋 UPDATE_WEEKLY_PLAN: Iniciando...', {
            sessionId,
            checklistItemsCount: data?.checklistItems?.length || 0,
            weekNumber: data?.weekNumber
          });
          const weeklyPlanResult = await updateWeeklyPlanAndShoppingList(
            id, sessionId, data?.checklistItems, data?.weekNumber || 1, requestId
          );
          return NextResponse.json(weeklyPlanResult);

        case 'import_session':
          console.log('📥 IMPORT_SESSION: Iniciando...', {
            monthNumber: data?.monthNumber,
            sessionDataKeys: data?.sessionData ? Object.keys(data.sessionData) : []
          });
          operationResult = await importSession(id, data?.sessionData, data?.monthNumber || 1, requestId);
          message = 'Sesión importada exitosamente';
          break;

        default:
          loggerWithContext.warn('AI', 'Acción no válida', { action });
          return NextResponse.json(
            { success: false, message: 'Acción no válida' },
            { status: 400 }
          );
      }

      // ⚠️ CORRECCIÓN: Usar la variable correcta `operationResult`
      if (!operationResult) {
        loggerWithContext.error('AI', 'No se pudo realizar la actualización');
        return NextResponse.json(
          { success: false, message: 'No se pudo realizar la actualización' },
          { status: 500 }
        );
      }

      console.log(`✅ ${action} completado exitosamente`);
      return NextResponse.json({
        success: true,
        message,
        requestId
      });

    } catch (error: any) {
      // Si es un error estructurado (auth/ownership), devolver su status específico
      if (error?.status) {
        return NextResponse.json(
          { success: false, message: error.message || 'Error' },
          { status: error.status }
        );
      }

      console.error('💥 ERROR en endpoint PUT:', error.message);
      logger.error('AI', 'Error en endpoint PUT', error);

      loggerWithContext.error('AI', 'Error actualizando recomendaciones IA', error);

      return NextResponse.json(
        {
          success: false,
          message: 'Error interno del servidor',
          requestId,
          ...(process.env.NODE_ENV === 'development' && {
            error: error.message
          })
        },
        { status: 500 }
      );
    }
  });
}

export const PUT = apiHandler(putHandler);

// ─── Helper: Extraer JSON limpio de respuestas de Gemini ───────────
/**
 * Gemini a veces devuelve JSON envuelto en bloques de código markdown
 * (```json ... ```) en lugar de JSON plano. Esta función sanitiza eso.
 */
function extractJSONFromMarkdown(text: string): string {
  // Patrón: ```json ... ``` o ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
  const match = text.match(codeBlockRegex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return text.trim();
}

// Funciones auxiliares
async function prepareAIInput(
  client: any,
  requestId: string,
  clientId: string
): Promise<any> {
  const loggerWithContext = logger.withContext({ requestId });

  loggerWithContext.debug('AI', 'Preparando entrada para IA');

  // Desencriptar datos personales
  const personalData = Object.entries(client.personalData || {}).reduce((acc, [key, value]) => {
    if (typeof value === 'string') {
      try {
        acc[key] = safeDecrypt(value as string);
      } catch (error) {
        loggerWithContext.warn('AI', `Error desencriptando campo personal: ${key}`, error as Error);
        acc[key] = value;
      }
    } else {
      acc[key] = value;
    }
    return acc;
  }, {} as any);

  // Desencriptar datos médicos
  const medicalData = Object.entries(client.medicalData || {}).reduce((acc, [key, value]) => {
    if (typeof value === 'string' && key !== 'documents' && key !== 'processedDocuments') {
      try {
        acc[key] = safeDecrypt(value as string);
      } catch (error) {
        loggerWithContext.warn('AI', `Error desencriptando campo médico: ${key}`, error as Error);
        acc[key] = value;
      }
    } else {
      acc[key] = value;
    }
    return acc;
  }, {} as any);

  const processedDocs: Array<{
    title: string; content: string; processedAt?: string; confidence?: number;
    type?: string; pageCount?: number; language?: string;
  }> = [];
  const failedDocumentAnalyses: GenerationError[] = [];
  let allLabResults: Array<{ name: string; value: string; range: string; status: 'normal' | 'alto' | 'bajo'; }> = [];
  let extractedMedicalSummary = '';

  if (client.medicalData?.documents && Array.isArray(client.medicalData.documents) && client.medicalData.documents.length > 0) {
    loggerWithContext.debug('AI', 'Analizando documentos reales con Gemini nativo (SECUENCIAL)', {
      documentCount: client.medicalData.documents.length
    });

    const totalAttempted = client.medicalData.documents.length;

      // Procesar documentos SECUENCIALMENTE para evitar 503 por concurrencia
      for (let docIndex = 0; docIndex < client.medicalData.documents.length; docIndex++) {
        const doc = client.medicalData.documents[docIndex];
        const fileName = safeDecrypt(doc.name || doc.originalName || 'Documento');
        const s3Key = safeDecrypt(doc.key || '');
        if (!s3Key) continue;

        // FAIL-FAST: 2 intentos máximo (1 inicial + 1 reintento)
        let docResult: any = null;

        // ── 1. Intentar caché antes de llamar a Gemini ──
        let cachedRawText: string | undefined;
        let cachedExtractionMethod: string | undefined;

        try {
          const cacheColl = await getMedicalDocumentCacheCollection();
          const cachedDoc = await cacheColl.findOne<Record<string, unknown>>(
            { s3Key, clientId: new ObjectId(clientId) },
          );

          if (cachedDoc) {
            const cachedAnalysis = cachedDoc.analysis as string | undefined;

            // Caso A: Cache TIENE análisis de Gemini completo → usar directamente
            if (cachedAnalysis && cachedAnalysis.length > 10) {
              try {
                const parsedAnalysis = JSON.parse(cachedAnalysis) as {
                  medicalSummary?: string;
                  medicalComparativeAnalysis?: string;
                  labResults?: Array<{ name: string; value: string; range: string; status: 'normal' | 'alto' | 'bajo' }>;
                  supplementRecommendations?: Array<{ name: string; dosage: string; timing: string; rationale: string; contraindications: string }>;
                };

                if (parsedAnalysis.labResults) {
                  allLabResults = allLabResults.concat(parsedAnalysis.labResults);
                }

                docResult = {
                  title: fileName,
                  content: cachedAnalysis,
                  processedAt: (cachedDoc.cachedAt as string) || new Date().toISOString(),
                  confidence: 1,
                  type: 'document',
                  pageCount: 1,
                  language: 'es',
                  medicalSummary: parsedAnalysis.medicalSummary,
                  medicalComparativeAnalysis: parsedAnalysis.medicalComparativeAnalysis,
                  labResults: parsedAnalysis.labResults,
                  supplementRecommendations: parsedAnalysis.supplementRecommendations,
                };

                loggerWithContext.info('AI', '📦 Usando análisis completo cacheado', {
                  fileName,
                  cachedAt: cachedDoc.cachedAt,
                });
                processedDocs.push(docResult);
                continue; // Saltar al siguiente documento
              } catch {
                // Análisis corrupto, ignorar y tratar como si no hubiera cache
                loggerWithContext.warn('AI', 'Cache analysis corrupto, re-analizando', { fileName });
              }
            }

            // Caso B: Cache tiene rawText pero no analysis (extraído post-upload, sin analizar aún)
            if (cachedDoc.rawText) {
              cachedRawText = cachedDoc.rawText as string;
              cachedExtractionMethod = cachedDoc.extractionMethod as string | undefined;
              loggerWithContext.info('AI', '📄 Usando rawText cacheado (sin analysis previo)', {
                fileName,
                method: cachedExtractionMethod,
                chars: cachedRawText.length,
              });
            }
          }
        } catch (cacheErr) {
          loggerWithContext.warn('AI', 'Error consultando caché, procediendo con Gemini', cacheErr as Error);
        }

        // ── 2. Si no hay caché, llamar a Gemini ──
        if (!docResult) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            loggerWithContext.debug('AI', 'Enviando documento a Gemini', {
              fileName: fileName.substring(0, 50),
              attempt: attempt + 1,
              docIndex: docIndex + 1,
              totalDocs: totalAttempted
            });

            // Prompt para pedir JSON con resultados de laboratorio
            const prompt = `Eres un analista médico experto. Extrae toda la información clínica relevante de este documento, organizándola en formato JSON con los siguientes campos:
- "medicalSummary": Un resumen conciso de los hallazgos principales.
- "medicalComparativeAnalysis": Si hay datos históricos, un análisis comparativo. Si no, indica que no aplica.
- "labResults": Un array de objetos con TODOS los biomarcadores encontrados en el documento sin omitir ninguno. Cada objeto debe tener "name", "value", "range", y "status" ('normal', 'alto', 'bajo'). EXTREMADAMENTE IMPORTANTE: Extrae todos los datos numéricos y de laboratorio. No resumas esta tabla.
- "supplementRecommendations": Un array de objetos para suplementos recomendados con "name", "dosage", "timing", "rationale", "contraindications". Si no hay, deja el array vacío.`;

            let geminiAnalysis: string;
            let rawText: string;
            let extractionMethod: string;

            if (cachedRawText) {
              // ✅ Ya tenemos el texto extraído (vía upload) — solo enviar a Gemini
              geminiAnalysis = await sendTextToGemini(cachedRawText, fileName, prompt);
              rawText = cachedRawText;
              extractionMethod = cachedExtractionMethod ?? 'cache';
              loggerWithContext.info('AI', 'Usando rawText cacheado (sin S3)', {
                fileName,
                extractionMethod,
                rawTextLength: rawText.length,
              });
            } else {
              // ❌ No hay rawText cacheado — extraer bajo demanda
              // Esto pasa cuando el upload no completó la extracción (timeout, error, etc.)
              loggerWithContext.warn('AI', 'Documento sin rawText — extrayendo bajo demanda', {
                fileName,
                s3Key: s3Key.substring(0, 50),
              });

              try {
                const presignedUrl = await getPresignedUrlForAnalysis(s3Key);
                const s3Response = await fetch(presignedUrl);
                if (!s3Response.ok) throw new Error(`S3 download failed: ${s3Response.status}`);

                const buffer = Buffer.from(await s3Response.arrayBuffer());
                const extracted = await extractTextFromBuffer(buffer, fileName, 'application/pdf');

                if (extracted.text.trim()) {
                  rawText = extracted.text;
                  extractionMethod = extracted.method;
                  geminiAnalysis = await sendTextToGemini(rawText, fileName, prompt);
                  loggerWithContext.info('AI', 'Texto extraído bajo demanda', {
                    fileName,
                    method: extractionMethod,
                    chars: rawText.length,
                  });
                } else {
                  loggerWithContext.warn('AI', 'No se pudo extraer texto del PDF bajo demanda', {
                    fileName,
                    method: extracted.method,
                  });
                  break;
                }
              } catch (extractErr) {
                const errMsg = extractErr instanceof Error ? extractErr.message : 'Error desconocido';
                loggerWithContext.warn('AI', `Extracción bajo demanda falló: ${errMsg}`, {
                  fileName,
                  s3Key: s3Key.substring(0, 50),
                });
                break;
              }
            }

            if (geminiAnalysis && geminiAnalysis.length > 20) {
              try {
                type ParsedAnalysis = {
                  medicalSummary?: string;
                  medicalComparativeAnalysis?: string;
                  labResults?: Array<{
                    name: string;
                    value: string;
                    range: string;
                    status: 'normal' | 'alto' | 'bajo';
                  }>;
                  supplementRecommendations?: Array<{
                    name: string;
                    dosage: string;
                    timing: string;
                    rationale: string;
                    contraindications: string;
                  }>;
                };

                const cleanJSON = extractJSONFromMarkdown(geminiAnalysis);
                const parsedAnalysis = JSON.parse(cleanJSON) as ParsedAnalysis;

                if (parsedAnalysis.labResults) {
                  allLabResults = allLabResults.concat(parsedAnalysis.labResults);
                }

                docResult = {
                  title: fileName,
                  content: JSON.stringify(parsedAnalysis),
                  processedAt: new Date().toISOString(),
                  confidence: 1,
                  type: 'document',
                  pageCount: 1,
                  language: 'es',
                  medicalSummary: parsedAnalysis.medicalSummary,
                  medicalComparativeAnalysis: parsedAnalysis.medicalComparativeAnalysis,
                  labResults: parsedAnalysis.labResults,
                  supplementRecommendations: parsedAnalysis.supplementRecommendations,
                };

                // ── 3. Guardar en caché tras análisis exitoso ──
                try {
                  const cacheColl = await getMedicalDocumentCacheCollection();
                  await cacheColl.updateOne(
                    { s3Key },
                    {
                      $set: {
                        s3Key,
                        clientId: new ObjectId(clientId),
                        fileName,
                        analysis: JSON.stringify(parsedAnalysis),
                        labResults: parsedAnalysis.labResults ?? [],
                        medicalSummary: parsedAnalysis.medicalSummary ?? '',
                        medicalComparativeAnalysis: parsedAnalysis.medicalComparativeAnalysis ?? '',
                        supplementRecommendations: parsedAnalysis.supplementRecommendations ?? [],
                        // 🆕 Texto extraído localmente (para re-análisis sin S3)
                        rawText,
                        extractionMethod,
                        extractedAt: new Date(),
                        cachedAt: new Date(),
                        updatedAt: new Date(),
                      },
                    },
                    { upsert: true }
                  );
                  loggerWithContext.debug('AI', '💾 Análisis médico + rawText guardados en caché', {
                    fileName,
                    extractionMethod,
                    rawTextLength: rawText.length,
                  });
                } catch (cacheErr) {
                  loggerWithContext.warn('AI', 'Error guardando caché de documento', cacheErr as Error);
                }

                break; // Success, exit retry loop
              } catch (parseError) {
                loggerWithContext.error('AI', 'Error parseando JSON de Gemini', parseError as Error, { fileName });
                throw new Error(`Error parseando la respuesta JSON de Gemini para ${fileName}`);
              }
            }
            break; // No analysis but no error either
          } catch (error: any) {
            const is503 = error?.message?.includes('503') || error?.message?.includes('UNAVAILABLE');
            const is404 = error?.message?.includes('404');
            const statusCode = error?.status || (is503 ? 503 : (is404 ? 404 : 500));
            const errorMessage = error?.message || 'Error desconocido al analizar documento';

            // FAIL-FAST: Si es 503 y es el último intento, se registra el error
            // pero NO se aborta toda la generación. El documento se agrega a
            // failedDocumentAnalyses y la generación continúa con los datos
            // disponibles (formularios, otros documentos ya procesados).
            if (is503 && attempt >= 1) {
              loggerWithContext.error('AI', '503 persistente tras reintento, continuando con siguiente documento', new Error(`503 persistente para ${fileName}`), {
                fileName,
                attemptsMade: 2,
              });
              // Fall through al GenerationError path en lugar de hacer throw
            }

            if ((is503 || is404) && attempt < 1) {
              const delay = 8000; // 8 segundos de seguridad entre intentos
              loggerWithContext.warn('AI', `${statusCode} en ${fileName}, reintento ${attempt + 2}/2 en ${delay}ms`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }

            const errorObj: GenerationError = {
              message: `Falló el análisis de ${fileName}: ${errorMessage}`,
              timestamp: new Date(),
              documentName: fileName,
              statusCode,
              stack: error?.stack,
            };
            loggerWithContext.error('AI', 'Error analizando documento con Gemini', error as Error, {
              fileName: doc?.name || 'unknown',
              errorDetails: errorMessage,
              statusCode,
            });
            docResult = errorObj;
            break; // Exit retry loop on final failure
          }
        }
        } // fin del bloque "si no hay caché"

        // Classify result
        if (docResult && !(docResult as GenerationError).message) {
          processedDocs.push(docResult);
        } else if (docResult) {
          failedDocumentAnalyses.push(docResult as GenerationError);
        }

        // Delay de 8 segundos entre documentos para priorizar estabilidad sobre velocidad
        if (docIndex < client.medicalData.documents.length - 1) {
          await new Promise(r => setTimeout(r, 8000));
        }
      }

    const successCount = processedDocs.length;
    const failCount = failedDocumentAnalyses.length;
    if (failCount > 0) {
      loggerWithContext.warn('AI', `${failCount}/${totalAttempted} documentos no pudieron analizarse.`);
    }

    // Extraer el mejor medicalSummary de los documentos procesados por Gemini
    const docSummaries = (processedDocs as any[])
      .filter(d => d.medicalSummary)
      .map(d => d.medicalSummary);
    if (docSummaries.length > 0) {
      extractedMedicalSummary = docSummaries.join('\n\n');
    }
  }

  // Combinar documentos
  const allDocuments = [...processedDocs];

  // Preparar historial de checklist si existe
  const previousChecklistStatus = [];
  if (client.aiProgress?.sessions) {
    for (const session of client.aiProgress.sessions as AIRecommendationSession[]) { // Cast to AIRecommendationSession
      if (session.checklist && Array.isArray(session.checklist)) {
        // Filtrar solo items completados para mostrar progreso
        const completedItems = session.checklist
        .filter((item: ChecklistItem) => item.completed)
        .map((item: ChecklistItem) => ({
          description: safeDecrypt(item.description || ''),
          completed: true,
          completedDate: item.completedDate
        }));

        previousChecklistStatus.push({
          month: session.monthNumber,
          completedItems,
          totalItems: session.checklist.length
        });
      }
    }
  }

  // Preparar historial de documentos (desde los archivos reales en S3)
  const documentHistory = [];
  if (client.medicalData?.documents && Array.isArray(client.medicalData.documents)) {
    const recentDocs = client.medicalData.documents
      .sort((a: any, b: any) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime())
      .slice(0, 5);
    for (const doc of recentDocs) {
      documentHistory.push({
        processedAt: doc.uploadedAt,
        processedBy: 'Gemini',
        confidence: 1,
        status: 'completed'
      });
    }
  }

  // Extraer evaluaciones de salud y salud mental con contexto legible
  const healthLabels: Record<string, string> = {
    carbohydrateAddiction: 'Adicción a carbohidratos (¿Sientes ansiedad por comer carbohidratos?)',
    leptinResistance: 'Resistencia a leptina (¿Tienes problemas para sentirte satisfecho al comer?)',
    circadianRhythms: 'Ritmos circadianos (¿Tus hábitos de sueño/comida son regulares?)',
    sleepHygiene: 'Higiene del sueño (Calidad y hábitos de sueño)',
    electrosmogExposure: 'Exposición a electrosmog (Exposición a campos electromagnéticos)',
    generalToxicity: 'Toxicidad general (Exposición a toxinas ambientales)',
    microbiotaHealth: 'Salud de microbiota (Salud digestiva e intestinal)',
  };
  const healthAssessment: Record<string, string> = {};
  for (const [key, label] of Object.entries(healthLabels)) {
    if (medicalData[key]) { healthAssessment[label] = medicalData[key]; }
  }

  const mentalLabels: Record<string, string> = {
    mentalHealthEmotionIdentification: 'Identificación de emociones (¿Identificas tus emociones?)',
    mentalHealthEmotionIntensity: 'Intensidad emocional (¿Manejas emociones intensas?)',
    mentalHealthUncomfortableEmotion: 'Emociones incómodas (¿Cómo enfrentas emociones difíciles?)',
    mentalHealthInternalDialogue: 'Diálogo interno (¿Cómo es tu diálogo interno?)',
    mentalHealthStressStrategies: 'Estrategias de estrés (¿Qué haces ante el estrés?)',
    mentalHealthSayingNo: 'Decir no (¿Puedes establecer límites?)',
    mentalHealthRelationships: 'Relaciones (Relaciones interpersonales)',
    mentalHealthExpressThoughts: 'Expresar pensamientos (¿Expresas lo que piensas?)',
    mentalHealthEmotionalDependence: 'Dependencia emocional (¿Eres emocionalmente independiente?)',
    mentalHealthPurpose: 'Propósito (¿Tienes claro tu propósito?)',
    mentalHealthFailureReaction: 'Reacción al fracaso (¿Cómo reaccionas ante fracasos?)',
    mentalHealthSelfConnection: 'Conexión personal (¿Estás conectado contigo mismo?)',
    mentalHealthSelfRelationship: 'Relación personal (Relación contigo mismo)',
    mentalHealthLimitingBeliefs: 'Creencias limitantes (¿Identificas creencias limitantes?)',
    mentalHealthIdealBalance: 'Equilibrio ideal (Describe tu equilibrio ideal)',
  };
  const mentalHealth: Record<string, string> = {};
  for (const [key, label] of Object.entries(mentalLabels)) {
    if (medicalData[key]) { mentalHealth[label] = medicalData[key]; }
  }

  loggerWithContext.debug('AI', 'Entrada para IA preparada', {
    personalDataKeys: Object.keys(personalData),
    medicalDataKeys: Object.keys(medicalData),
    processedDocsCount: processedDocs.length,
    totalDocs: allDocuments.length,
    documentHistoryCount: documentHistory.length,
    failedDocumentAnalysesCount: failedDocumentAnalyses.length,
  });

  return {
    personalData,
    medicalData,
    healthAssessment,
    mentalHealth,
    documents: allDocuments, // ✅ Documentos procesados
    documentHistory, // ✅ Historial de procesamientos
    previousChecklistStatus,
    previousSessions: client.aiProgress?.sessions || [],
    allLabResults, // All lab results from documents
    extractedMedicalSummary, // Resumen médico extraído de PDFs
    // Información adicional para el prompt
    meta: {
      totalProcessedDocuments: processedDocs.length,
      hasDocumentHistory: documentHistory.length > 0,
      lastDocumentProcessed: client.medicalData?.lastDocumentProcessed
    },
    failedDocumentAnalyses,
  };
}

async function updateChecklist(
  clientId: string,
  sessionId: string,
  checklistItems: ChecklistItem[],
  requestId: string
): Promise<any> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI', '🚀 Iniciando actualización de checklist', {
    sessionId,
    itemCount: checklistItems.length,
    completedCount: checklistItems.filter(item => item.completed).length
  });

  try {
    const healthForms = await getHealthFormsCollection();

    // 1. Obtener el cliente y la sesión actual
    const client = await healthForms.findOne({
      _id: new ObjectId(clientId),
      'aiProgress.sessions.sessionId': sessionId
    });

    if (!client || !client.aiProgress) {
      throw new Error('Cliente o sesión no encontrada');
    }

    const sessionIndex = client.aiProgress.sessions.findIndex(
      (s: any) => s.sessionId === sessionId
    );

    if (sessionIndex === -1) {
      throw new Error('Sesión no encontrada');
    }

    // 2. Encriptar el checklist recibido (viene desencriptado del frontend)
    const encryptedChecklistItems: ChecklistItem[] = checklistItems.map((item) => ({
      ...item,
      description: encrypt(item.description),
      details: item.details ? {
        ...item.details,
        recipe: item.details.recipe ? {
          ...item.details.recipe,
          ingredients: item.details.recipe.ingredients.map(ing => ({
            name: encrypt(ing.name),
            quantity: encrypt(ing.quantity),
            notes: ing.notes ? encrypt(ing.notes) : undefined
          })),
          preparation: encrypt(item.details.recipe.preparation),
          tips: item.details.recipe.tips ? encrypt(item.details.recipe.tips) : undefined
        } : undefined,
        frequency: item.details.frequency ? encrypt(item.details.frequency) : undefined,
        duration: item.details.duration ? encrypt(item.details.duration) : undefined,
        equipment: item.details.equipment?.map(eq => encrypt(eq))
      } : undefined
    }));

    // 3. Actualizar SOLO el campo checklist de la sesión (NO weeks)
    const updateResult = await healthForms.updateOne(
      {
        _id: new ObjectId(clientId),
        'aiProgress.sessions.sessionId': sessionId
      },
      {
        $set: {
          'aiProgress.sessions.$.checklist': encryptedChecklistItems,
          'aiProgress.sessions.$.updatedAt': new Date(),
          'aiProgress.lastEvaluation': new Date(),
          updatedAt: new Date()
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      throw new Error('No se pudo actualizar la base de datos');
    }

    // 4. Obtener el cliente actualizado y devolver la sesión desencriptada
    const updatedClient = await healthForms.findOne({
      _id: new ObjectId(clientId)
    });

    if (!updatedClient?.aiProgress) {
      throw new Error('No se pudo obtener el cliente actualizado');
    }

    const updatedSessionIndex = updatedClient.aiProgress.sessions.findIndex(
      (s: any) => s.sessionId === sessionId
    );

    const updatedSession = updatedClient.aiProgress.sessions[updatedSessionIndex];
    const decryptedSession = decryptAISessionCompletely(updatedSession);

    const completedItems = decryptedSession.checklist?.filter((item: any) => item.completed).length || 0;
    const totalItems = decryptedSession.checklist?.length || 0;
    const progress = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    return {
      success: true,
      data: {
        session: decryptedSession,
        progress,
        completedItems,
        totalItems
      }
    };

  } catch (error: any) {
    loggerWithContext.error('AI', '💥 Error actualizando checklist', error);
    return {
      success: false,
      // SEC (A10): mensaje genérico, detalle solo en logs
      message: 'Error actualizando el checklist'
    };
  }
}

async function approveSession(clientId: string, sessionId: string, requestId: string): Promise<boolean> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI', '✅ Aprobando sesión (sin enviar email)', { sessionId });

  try {
    const healthForms = await getHealthFormsCollection();

    // 1. Primero buscar el cliente
    const client = await healthForms.findOne({
      _id: new ObjectId(clientId)
    });

    if (!client || !client.aiProgress) {
      loggerWithContext.warn('AI', 'Cliente o progreso de IA no encontrado', {
        clientId,
        hasClient: !!client,
        hasAIProgress: !!client?.aiProgress
      });
      return false;
    }

    // 2. Verificar que la sesión existe y está en estado 'draft'
    const sessionIndex = client.aiProgress.sessions.findIndex(
      (s: any) => s.sessionId === sessionId
    );

    if (sessionIndex === -1) {
      loggerWithContext.warn('AI', 'Sesión no encontrada', {
        clientId,
        sessionId,
        availableSessions: client.aiProgress.sessions?.map((s: any) => ({
          sessionId: s.sessionId,
          status: s.status
        }))
      });
      return false;
    }

    const targetSession = client.aiProgress.sessions[sessionIndex];

    if (targetSession.status !== 'draft') {
      loggerWithContext.warn('AI', 'Sesión no está en estado draft', {
        sessionId,
        currentStatus: targetSession.status,
        requiredStatus: 'draft'
      });
      return false;
    }

    // 3. Actualizar solo el estado a 'approved'
    const result = await healthForms.updateOne(
      {
        _id: new ObjectId(clientId),
        'aiProgress.sessions.sessionId': sessionId
      },
      {
        $set: {
          'aiProgress.sessions.$.status': 'approved',
          'aiProgress.sessions.$.approvedAt': new Date(),
          'aiProgress.sessions.$.updatedAt': new Date(),
          'aiProgress.updatedAt': new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      loggerWithContext.info('AI', '✅ Sesión aprobada exitosamente (email NO enviado)', {
        sessionId,
        modifiedCount: result.modifiedCount,
        matchedCount: result.matchedCount
      });
      return true;
    } else {
      loggerWithContext.warn('AI', 'No se modificó ningún documento al aprobar sesión', {
        sessionId,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      });
      return false;
    }

  } catch (error: any) {
    loggerWithContext.error('AI', '❌ Error aprobando sesión', error);
    return false;
  }
}

async function sendToClient(clientId: string, sessionId: string, requestId: string): Promise<boolean> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI', '📤 Enviando sesión al cliente via email', { sessionId });

  try {
    const healthForms = await getHealthFormsCollection();

    // 1. Obtener el cliente completo
    const client = await healthForms.findOne({
      _id: new ObjectId(clientId),
      'aiProgress.sessions.sessionId': sessionId
    });

    if (!client || !client.aiProgress) {
      loggerWithContext.warn('AI', 'Cliente o progreso de IA no encontrado');
      return false;
    }

    // 2. Encontrar la sesión específica
    const sessionIndex = client.aiProgress.sessions.findIndex(
      (s: any) => s.sessionId === sessionId
    );

    if (sessionIndex === -1) {
      loggerWithContext.warn('AI', 'Sesión no encontrada', { sessionId });
      return false;
    }

    const session = client.aiProgress.sessions[sessionIndex];

    // 3. Verificar que la sesión esté aprobada (o ya enviada para reenvío)
    if (session.status !== 'approved' && session.status !== 'sent') {
      loggerWithContext.warn('AI', 'Sesión no está aprobada ni enviada', {
        sessionId,
        currentStatus: session.status,
        requiredStatus: 'approved o sent'
      });
      return false;
    }

    // 4. Desencriptar la sesión completa para el email
    const decryptedSession = decryptAISessionCompletely(session);

    // 5. Obtener y desencriptar el email del cliente
    let clientEmail = '';
    let clientName = 'Cliente';

    try {
      if (client.personalData?.email) {
        clientEmail = safeDecrypt(client.personalData.email);
      }

      if (client.personalData?.name) {
        clientName = safeDecrypt(client.personalData.name);
      }
    } catch (error) {
      loggerWithContext.warn('AI', 'Error desencriptando datos personales', error as Error);

      // Intentar usar datos sin desencriptar si falla
      clientEmail = client.personalData?.email || '';
      clientName = client.personalData?.name || 'Cliente';
    }

    // 6. Validar que el cliente tenga email
    if (!clientEmail || !clientEmail.includes('@')) {
      loggerWithContext.error('AI', 'Email del cliente inválido o no encontrado', undefined, {
        clientEmail,
        clientId,
        sessionId
      });
      return false;
    }

    // 7. Obtener datos del coach asignado
    let coachName = '';
    let coachEmail = '';
    let coachPhone = '';
    let coachPhotoUrl: string | null = null;
    try {
      if (client.coachId) {
        await connectMongoose();
        const coach = await Coach.findById(client.coachId);
        if (coach) {
          coachName = `${decrypt(coach.firstName)} ${decrypt(coach.lastName)}`.trim();
          coachEmail = decrypt(coach.email);
          coachPhone = coach.phone ? decrypt(coach.phone) : '';
          coachPhotoUrl = coach.profilePhoto?.url ? decrypt(coach.profilePhoto.url) : null;
        }
      }
    } catch (coachErr) {
      loggerWithContext.warn('AI', 'No se pudieron obtener datos del coach', coachErr as Error);
    }

    // 8. Enviar email con el plan mensual usando EmailService
    let emailSent = false;
    let emailError: any = null;

    try {
      loggerWithContext.info('EMAIL', '✉️ Iniciando envío de email de plan mensual', {
        clientEmail,
        clientName,
        monthNumber: session.monthNumber
      });

      const emailService = EmailService.getInstance();

      // Verificar configuración del email
      const configCheck = await emailService.testConfiguration();
      loggerWithContext.debug('EMAIL', 'Configuración del servicio de email', configCheck);

      if (!configCheck.configured) {
        loggerWithContext.warn('EMAIL', 'Servicio de email no configurado correctamente', {
          issues: configCheck.issues,
          fromEmail: configCheck.fromEmail
        });
      }

      // Construir URL de descarga del PDF
      // En Vercel producción usa VERCEL_URL automático; en dev usa API_URL o APP_URL
      const apiBaseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001');
      const pdfDownloadUrl = `${apiBaseUrl}/api/clients/${clientId}/ai/${sessionId}/pdf`;

      emailSent = await emailService.sendMonthlyPlanEmail(
        clientEmail,
        clientName,
        decryptedSession,
        session.monthNumber,
        { clientId, sessionId, requestId },
        { coachName, coachEmail, coachPhone, coachPhotoUrl },
        pdfDownloadUrl
      );

      if (emailSent) {
        loggerWithContext.info('EMAIL', '✅ Email enviado exitosamente', {
          clientEmail,
          clientName,
          monthNumber: session.monthNumber
        });
      } else {
        loggerWithContext.warn('EMAIL', '❌ Email no se pudo enviar', {
          clientEmail,
          clientName
        });
      }

    } catch (err: any) {
      emailError = err;
      loggerWithContext.error('EMAIL', 'Error enviando email', err);
    }

    // 8. Determinar el estado final basado en el éxito del email
    const newStatus = emailSent ? 'sent' : 'approved'; // Si falla el email, mantener como aprobado
    const updateData: any = {
      $set: {
        'aiProgress.sessions.$.status': newStatus,
        'aiProgress.sessions.$.updatedAt': new Date(),
        'aiProgress.sessions.$.emailSent': emailSent,
        'aiProgress.sessions.$.emailSentAt': emailSent ? new Date() : undefined
      }
    };

    if (emailError) {
      updateData.$set['aiProgress.sessions.$.emailError'] = emailError.message;
    }

    // 9. Actualizar la sesión en la base de datos
    const result = await healthForms.updateOne(
      {
        _id: new ObjectId(clientId),
        'aiProgress.sessions.sessionId': sessionId
      },
      updateData
    );

    if (result.modifiedCount > 0) {
      if (emailSent) {
        loggerWithContext.info('AI', '✅ Sesión enviada al cliente exitosamente', {
          sessionId,
          clientEmail,
          clientName,
          monthNumber: session.monthNumber
        });
      } else {
        loggerWithContext.warn('AI', '⚠️ Sesión NO se pudo enviar al cliente (email falló)', {
          sessionId,
          clientEmail,
          clientName,
          emailError: emailError?.message || 'Servicio de email no configurado'
        });
      }
      return emailSent; // Retorna true solo si el email se envió
    } else {
      loggerWithContext.warn('AI', 'No se modificó ningún documento al enviar sesión', { sessionId });
      return false;
    }

  } catch (error: any) {
    loggerWithContext.error('AI', '💥 Error enviando sesión al cliente', error);
    return false;
  }
}

async function regenerateSession(clientId: string, sessionId: string, coachNotes: string, requestId: string): Promise<boolean> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI_REGEN', '🚀 Iniciando proceso de regeneración', {
    sessionId,
    hasCoachNotes: !!coachNotes && coachNotes.trim().length > 0,
    notesLength: coachNotes?.length || 0
  });

  try {
    const healthForms = await getHealthFormsCollection();

    // 1. Obtener el cliente y la sesión actual
    loggerWithContext.debug('AI_REGEN', 'Buscando cliente y sesión', { clientId, sessionId });

    const client = await healthForms.findOne({
      _id: new ObjectId(clientId),
      'aiProgress.sessions.sessionId': sessionId
    });

    if (!client || !client.aiProgress) {
      loggerWithContext.error('AI_REGEN', 'Cliente o progreso de IA no encontrado', undefined, {
        clientId,
        hasClient: !!client,
        hasAIProgress: !!client?.aiProgress
      });
      return false;
    }

    // 2. Encontrar la sesión específica
    const sessionIndex = client.aiProgress.sessions.findIndex(
      (s: any) => s.sessionId === sessionId
    );

    if (sessionIndex === -1) {
      loggerWithContext.error('AI_REGEN', 'Sesión no encontrada', undefined, { sessionId });
      return false;
    }

    const existingSession = client.aiProgress.sessions[sessionIndex];

    // 3. ✅ VERIFICAR QUE LA SESIÓN ESTÉ EN ESTADO 'draft'
    loggerWithContext.debug('AI_REGEN', 'Verificando estado de sesión', {
      sessionId,
      currentStatus: existingSession.status,
      allowed: existingSession.status === 'draft'
    });

    if (existingSession.status !== 'draft') {
      loggerWithContext.error('AI_REGEN', '❌ No se puede regenerar - sesión no está en estado draft', undefined, {
        sessionId,
        currentStatus: existingSession.status,
        allowedStatuses: ['draft']
      });
      throw new Error(`Solo se pueden regenerar sesiones en estado 'draft'. Estado actual: '${existingSession.status}'`);
    }

    loggerWithContext.info('AI_REGEN', '✅ Sesión validada para regeneración', {
      sessionId,
      monthNumber: existingSession.monthNumber,
      status: existingSession.status
    });

    // 4. Preparar datos para la IA incluyendo notas del coach
    loggerWithContext.info('AI_REGEN', '🔄 Preparando datos para regeneración');

    const aiInput = await prepareAIInput(client, requestId, clientId);

    // Agregar notas del coach si las hay
    if (coachNotes && coachNotes.trim().length > 0) {
      aiInput.coachNotes = coachNotes;
      loggerWithContext.debug('AI_REGEN', 'Notas del coach incluidas', {
        notesLength: coachNotes.length,
        preview: coachNotes.substring(0, 100) + (coachNotes.length > 100 ? '...' : '')
      });
    } else {
      loggerWithContext.debug('AI_REGEN', 'No hay notas del coach, regenerando sin modificaciones');
    }

    // Agregar sesiones anteriores (excluyendo la actual si es necesario)
    if (client.aiProgress.sessions && client.aiProgress.sessions.length > 0) {
      const otherSessions = client.aiProgress.sessions.filter(
        (s: any, idx: number) => idx !== sessionIndex
      );
      aiInput.previousSessions = otherSessions;
      loggerWithContext.debug('AI_REGEN', 'Sesiones anteriores incluidas', {
        count: otherSessions.length
      });
    }

    // 5. Generar NUEVAS recomendaciones con generateCompositeRecommendation (NUEVA FORMA)
    loggerWithContext.info('AI_REGEN', '🤖 Llamando a generateCompositeRecommendation', {
      monthNumber: existingSession.monthNumber,
      hasPreviousSessions: aiInput.previousSessions?.length || 0
    });

    const {
      mentalHealth,
      healthAssessment,
      documents: processedDocuments,
    } = aiInput;

    const compositeResult = await generateCompositeRecommendation({
      personalData: aiInput.personalData || {},
      medicalData: aiInput.medicalData || {},
      healthAssessment: healthAssessment || {},
      mentalHealth: mentalHealth || {},
      processedDocuments: (processedDocuments || []).map((d: any) => ({
        title: d.title || '',
        content: d.content || '',
        documentType: d.documentType || 'other',
        confidence: d.confidence || 0,
      })),
      previousSessions: (aiInput.previousSessions || []) as any,
      coachNotes: aiInput.coachNotes || '',
      monthNumber: existingSession.monthNumber,
    });

    loggerWithContext.info('AI_REGEN', '✅ Nuevas recomendaciones generadas con generateCompositeRecommendation', {
      weekCount: compositeResult.nutritionPlan?.weeklyPlan?.length || 7,
    });

    // IDs de recetas y ejercicios encontrados en la DB
    const recipeIds: Record<string, string> = compositeResult._recipeIds || {};
    const exerciseIds: Record<string, string> = compositeResult._exerciseIds || {};

    // 6. Construir nueva sesión (mismo formato que POST handler)
    const newSessionId = `regen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const dayTranslations: Record<string, string> = {
      Monday: 'Lunes', Tuesday: 'Martes', Wednesday: 'Miércoles',
      Thursday: 'Jueves', Friday: 'Viernes', Saturday: 'Sábado', Sunday: 'Domingo'
    };

    const newChecklistItems: ChecklistItem[] = [];

    // Items de nutrición (desayuno/almuerzo/cena para cada día)
    if (compositeResult.nutritionPlan?.weeklyPlan) {
      for (const day of compositeResult.nutritionPlan.weeklyPlan) {
        const dayName = dayTranslations[day.day] || day.day;
        for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
          const mealName = meal === 'breakfast' ? 'Desayuno' : meal === 'lunch' ? 'Almuerzo' : 'Cena';
          const recipe = day[meal];
          if (recipe) {
            const recipeId = recipeIds[recipe] || '';
            newChecklistItems.push({
              id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              description: `${dayName} ${mealName}: ${recipe}`,
              completed: false,
              weekNumber: 1,
              category: 'nutrition',
              type: mealName.toLowerCase(),
              recipeId,
              details: recipeId ? undefined : { recipe: { ingredients: [], preparation: recipe } },
              isRecurring: false,
            } as ChecklistItem);
          }
        }
      }
    }

    // Items de ejercicios
    if (compositeResult.exercisePlan?.weeklyRoutine) {
      for (const day of compositeResult.exercisePlan.weeklyRoutine) {
        const dayName = dayTranslations[day.day] || day.day;
        if (day.exercises) {
          for (const ex of day.exercises) {
            const exerciseId = exerciseIds[ex.name] || '';
            newChecklistItems.push({
              id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              description: `${dayName}: ${ex.name}`,
              completed: false,
              weekNumber: 1,
              category: 'exercise',
              type: 'ejercicio',
              recipeId: exerciseId,
              details: {
                duration: `${ex.sets || 3} series x ${ex.repetitions || '12'} reps`,
                equipment: compositeResult.exercisePlan?.equipment,
                frequency: day.day,
              },
              isRecurring: false,
            } as ChecklistItem);
          }
        }
      }
    }

    // Items de hábitos (adoptar)
    if (compositeResult.habitPlan?.toAdopt) {
      for (const h of compositeResult.habitPlan.toAdopt) {
        newChecklistItems.push({
          id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          description: h.habit || 'Nuevo hábito',
          completed: false,
          weekNumber: 1,
          category: 'habit',
          type: 'toAdopt',
          isRecurring: true,
          details: { trigger: h.trigger || undefined },
        } as ChecklistItem);
      }
    }

    // Items de hábitos (eliminar)
    if (compositeResult.habitPlan?.toEliminate) {
      for (const h of compositeResult.habitPlan.toEliminate) {
        newChecklistItems.push({
          id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          description: h.habit ? (h.replacement ? `${h.habit} → ${h.replacement}` : h.habit) : 'Eliminar hábito',
          completed: false,
          weekNumber: 1,
          category: 'habit',
          type: 'toEliminate',
          isRecurring: true,
        } as ChecklistItem);
      }
    }

    // Items de alternativas
    if (compositeResult.alternatives) {
      for (const alt of compositeResult.alternatives) {
        const altRecipeId = compositeResult._recipeIds?.[alt.recipe] || '';
        newChecklistItems.push({
          id: `check_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          description: `🔄 Alternativa - ${alt.meal}: ${alt.recipe}`,
          completed: false,
          weekNumber: 1,
          category: 'nutrition',
          type: 'alternativa',
          recipeId: altRecipeId,
          notes: alt.description || '',
          isRecurring: false,
        } as ChecklistItem);
      }
    }

    // Construir weeks[] con datos en PLANO (se cifran tras la FASE 4)
    const shopList = Array.isArray(compositeResult.nutritionPlan?.shoppingList)
      ? compositeResult.nutritionPlan!.shoppingList
      : [];
    const newWeeks = [{
      weekNumber: 1 as const,
      nutrition: {
        focus: `Plan de comidas: ${compositeResult.nutritionPlan?.weeklyPlan?.length || 7} días, 3 comidas al día`,
        shoppingList: shopList.filter((item: any) => item?.item && item?.quantity).map((item: any) => ({
          item: item.item!,
          quantity: item.quantity!,
          priority: item.priority || 'medium',
        })),
      },
      exercise: {
        focus: compositeResult.exercisePlan?.notes || 'Rutina de ejercicios',
        equipment: (compositeResult.exercisePlan?.equipment || []).map((eq: string) => eq || ''),
      },
      habits: {
        trackingMethod: compositeResult.habitPlan?.trackingMethod || undefined,
        motivationTip: compositeResult.habitPlan?.motivationTip || undefined,
      },
    }];

    // Sesión en PLANO (sin cifrar)
    const newSessionPlain: AIRecommendationSession = {
      sessionId: newSessionId,
      monthNumber: existingSession.monthNumber,
      totalWeeks: 4,
      createdAt: existingSession.createdAt,
      updatedAt: new Date(),
      status: 'draft',
      summary: compositeResult.clientInsights?.summary || '',
      vision: compositeResult.clientInsights?.vision || compositeResult.clientInsights?.summary || '',
      medicalSummary: compositeResult.clientInsights?.medicalSummary || '',
      medicalComparativeAnalysis: compositeResult.clientInsights?.medicalComparativeAnalysis || '',
      labResults: compositeResult.clientInsights?.labResults || [],
      baselineMetrics: {
        currentLifestyle: compositeResult.clientInsights?.keyRisks || [],
        targetLifestyle: compositeResult.clientInsights?.targetImprovements || [],
      },
      weeks: newWeeks,
      checklist: newChecklistItems,
      coachNotes: (coachNotes && coachNotes.trim().length > 0) ? coachNotes : (existingSession.coachNotes || undefined),
      lastCoachNotes: (coachNotes && coachNotes.trim().length > 0) ? coachNotes : undefined,
      regenerationCount: (existingSession.regenerationCount || 0) + 1,
      regenerationHistory: [
        ...(existingSession.regenerationHistory || []),
        {
          timestamp: new Date(),
          previousSessionId: existingSession.sessionId,
          coachNotes: coachNotes || null,
          triggeredBy: 'coach',
        }
      ],
      regeneratedAt: new Date(),
    };

    // ── FASE 4: traducción dinámica (mismo patrón que el POST) ──
    const regenTargetLang = normalizeClientLang(aiInput.personalData?.language);
    let regenTranslationMeta: { targetLang: SupportedLang; sourceLang: SupportedLang } | undefined;
    let regenSessionToEncrypt = newSessionPlain;

    if (regenTargetLang !== 'es') {
      const usedRecipeIds = Array.from(new Set(Object.values(recipeIds).filter(Boolean))) as string[];
      const usedExerciseIds = Array.from(new Set(Object.values(exerciseIds).filter(Boolean))) as string[];
      const sourceLang = await detectSessionSourceLang(usedRecipeIds, usedExerciseIds, loggerWithContext);
      regenTranslationMeta = { targetLang: regenTargetLang, sourceLang };
      loggerWithContext.info('AI_REGEN', '🌍 FASE 4 (regeneración): traduciendo al idioma del cliente', {
        targetLang: regenTargetLang,
        sourceLang: `${sourceLang} (${LANG_LABELS[sourceLang]})`,
      });
      regenSessionToEncrypt = await translateSessionContent(
        newSessionPlain,
        regenTargetLang,
        LANG_LABELS[sourceLang],
        defaultLLM
      );
    }

    const newSession = encryptSessionFields(regenSessionToEncrypt, regenTranslationMeta);

    loggerWithContext.info('AI_REGEN', '✅ Nueva sesión construida y guardando en BD', {
      newSessionId,
      monthNumber: existingSession.monthNumber,
      weekCount: newWeeks.length,
      checklistItemCount: newChecklistItems.length,
    });

    // 7. Actualizar la sesión en la base de datos (REEMPLAZAR)
    const updateData: Record<string, Record<string, unknown> | Date> = {
      $set: {
        'aiProgress.sessions.$': newSession,
        'aiProgress.currentSessionId': newSessionId,
        'aiProgress.lastEvaluation': new Date(),
        updatedAt: new Date(),
      }
    };

    const result = await healthForms.updateOne(
      {
        _id: new ObjectId(clientId),
        'aiProgress.sessions.sessionId': sessionId
      },
      updateData
    );

    loggerWithContext.debug('AI_REGEN', 'Resultado de actualización en BD', {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      oldSessionId: sessionId,
      newSessionId: newSessionId
    });

    if (result.modifiedCount > 0) {
      loggerWithContext.info('AI_REGEN', '🎉 Regeneración completada exitosamente', {
        oldSessionId: sessionId,
        newSessionId: newSessionId,
        monthNumber: existingSession.monthNumber,
        regenerationNumber: (existingSession.regenerationCount || 0) + 1
      });
      return true;
    } else {
      loggerWithContext.error('AI_REGEN', '❌ No se modificó ningún documento', undefined, {
        sessionId,
        matchedCount: result.matchedCount
      });
      return false;
    }

  } catch (error: any) {
    loggerWithContext.error('AI_REGEN', '💥 Error en proceso de regeneración', error);

    // Enviar error específico si es por estado incorrecto
    if (error.message.includes("estado 'draft'")) {
      throw error; // Propagar error específico
    }

    return false;
  }
}

async function debugSessionStatus(clientId: string, targetSessionId: string): Promise<any> {
  try {
    const healthForms = await getHealthFormsCollection();
    const client = await healthForms.findOne({
      _id: new ObjectId(clientId)
    });

    if (!client?.aiProgress) {
      return { error: 'Cliente sin progreso de IA' };
    }

    const sessions = client.aiProgress.sessions || [];

    return {
      clientId,
      totalSessions: sessions.length,
      targetSession: sessions.find((s: any) => s.sessionId === targetSessionId),
      allSessions: sessions.map((s: any) => ({
        sessionId: s.sessionId,
        monthNumber: s.monthNumber,
        status: s.status,
        updatedAt: s.updatedAt
      }))
    };
  } catch (error: any) {
    return { error: error.message };
  }
}

async function updateSessionFields(
  clientId: string,
  sessionId: string,
  fields: {
    summary?: string;
    vision?: string;
    structuredMedicalAnalysis?: {
      examIndex: number;
      field: 'intro' | 'analysis';
      value: string;
    };
    exerciseIntro?: {
      weekIndex: number;
      value: string;
    };
  },
  requestId: string
): Promise<any> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI', 'Actualizando campos de sesión', { sessionId, fields });

  try {
    const healthForms = await getHealthFormsCollection();

    // Construir objeto de actualización dinámico
    const updateFields: any = {};
    if (fields.summary !== undefined) {
      updateFields['aiProgress.sessions.$.summary'] = encrypt(fields.summary);
    }
    if (fields.vision !== undefined) {
      updateFields['aiProgress.sessions.$.vision'] = encrypt(fields.vision);
    }
    if (fields.structuredMedicalAnalysis !== undefined) {
      const { examIndex, field, value } = fields.structuredMedicalAnalysis;
      const key = `aiProgress.sessions.$.structuredMedicalAnalysis.exams.${examIndex}.${field}`;
      updateFields[key] = encrypt(value);
    }
    if (fields.exerciseIntro !== undefined) {
      const { weekIndex, value } = fields.exerciseIntro;
      const key = `aiProgress.sessions.$.weeks.${weekIndex}.exercise.intro`;
      updateFields[key] = encrypt(value);
    }
    updateFields['aiProgress.sessions.$.updatedAt'] = new Date();
    updateFields['aiProgress.updatedAt'] = new Date();
    updateFields['updatedAt'] = new Date();

    const result = await healthForms.updateOne(
      {
        _id: new ObjectId(clientId),
        'aiProgress.sessions.sessionId': sessionId
      },
      { $set: updateFields }
    );

    if (result.modifiedCount === 0) {
      throw new Error('No se pudo actualizar la sesión');
    }

    // Obtener la sesión actualizada para devolverla
    const updatedClient = await healthForms.findOne({ _id: new ObjectId(clientId) });
    const updatedSession = updatedClient?.aiProgress?.sessions?.find(
      (s: any) => s.sessionId === sessionId
    );

    if (!updatedSession) {
      throw new Error('Sesión no encontrada después de actualizar');
    }

    const decryptedSession = decryptAISessionCompletely(updatedSession);

    return {
      success: true,
      data: {
        session: decryptedSession
      }
    };

  } catch (error: any) {
    loggerWithContext.error('AI', 'Error actualizando campos de sesión', error);
    return {
      success: false,
      // SEC (A10): mensaje genérico, detalle solo en logs
      message: 'Error actualizando los campos de la sesión'
    };
  }
}

async function importSession(
  clientId: string,
  sessionData: any,
  monthNumber: number = 1,
  requestId: string
): Promise<boolean> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI', '📥 Iniciando importación de sesión', {
    monthNumber,
    sessionDataKeys: sessionData ? Object.keys(sessionData) : [],
    hasSummary: !!sessionData?.summary,
    hasVision: !!sessionData?.vision,
    weeksCount: sessionData?.weeks?.length || 0,
    checklistCount: sessionData?.checklist?.length || 0
  });

  try {
    const healthForms = await getHealthFormsCollection();
    const client = await healthForms.findOne({ _id: new ObjectId(clientId) });

    if (!client) {
      loggerWithContext.warn('AI', 'Cliente no encontrado');
      return false;
    }

    loggerWithContext.debug('AI', 'Cliente encontrado para importación', {
      hasPersonalData: !!client.personalData,
      hasMedicalData: !!client.medicalData,
      existingSessions: client.aiProgress?.sessions?.length || 0
    });

    // Validar datos mínimos de la sesión
    if (!sessionData.summary || !sessionData.vision) {
      loggerWithContext.error('AI', 'Datos de sesión incompletos', undefined, {
        hasSummary: !!sessionData.summary,
        hasVision: !!sessionData.vision
      });
      throw new Error('La sesión debe incluir summary y vision');
    }

    // Generar nuevo sessionId
    const sessionId = crypto.randomUUID();

    // Preparar semanas (asegurar estructura correcta)
    const weeks = sessionData.weeks || [];
    const validatedWeeks = weeks.map((week: any, index: number) => ({
      weekNumber: week.weekNumber || (index + 1),
      nutrition: {
        focus: week.nutrition?.focus || 'Nutrición personalizada',
        shoppingList: week.nutrition?.shoppingList || []
      },
      exercise: {
        focus: week.exercise?.focus || 'Ejercicio adaptado',
        equipment: week.exercise?.equipment || []
      },
      habits: {
        trackingMethod: week.habits?.trackingMethod,
        motivationTip: week.habits?.motivationTip
      }
    }));

    // Preparar checklist (encriptar descripciones)
    const checklist = sessionData.checklist || [];
    const encryptedChecklist = checklist.map((item: any) => ({
      ...item,
      description: encrypt(item.description || ''),
      details: item.details ? {
        ...item.details,
        recipe: item.details.recipe ? {
          ...item.details.recipe,
          ingredients: item.details.recipe.ingredients?.map((ing: any) => ({
            name: encrypt(ing.name || ''),
            quantity: encrypt(ing.quantity || ''),
            notes: ing.notes ? encrypt(ing.notes) : undefined
          })) || [],
          preparation: encrypt(item.details.recipe.preparation || ''),
          tips: item.details.recipe.tips ? encrypt(item.details.recipe.tips) : undefined
        } : undefined,
        frequency: item.details.frequency ? encrypt(item.details.frequency) : undefined,
        duration: item.details.duration ? encrypt(item.details.duration) : undefined,
        equipment: item.details.equipment?.map((eq: string) => encrypt(eq))
      } : undefined
    }));

    // Crear objeto de sesión completo (encriptar campos sensibles)
    const newSession = {
      sessionId,
      monthNumber,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'draft', // Por defecto en estado borrador
      summary: encrypt(sessionData.summary),
      vision: encrypt(sessionData.vision),
      baselineMetrics: sessionData.baselineMetrics || { currentLifestyle: [], targetLifestyle: [] },
      weeks: validatedWeeks.map((week: any) => ({
        weekNumber: week.weekNumber,
        nutrition: {
          focus: encrypt(week.nutrition.focus),
          shoppingList: week.nutrition.shoppingList.map((item: any) => ({
            item: encrypt(item.item || ''),
            quantity: encrypt(item.quantity || ''),
            priority: item.priority || 'medium'
          }))
        },
        exercise: {
          focus: encrypt(week.exercise.focus),
          equipment: week.exercise.equipment.map((eq: string) => encrypt(eq))
        },
        habits: {
          trackingMethod: week.habits.trackingMethod ? encrypt(week.habits.trackingMethod) : undefined,
          motivationTip: week.habits.motivationTip ? encrypt(week.habits.motivationTip) : undefined
        }
      })),
      checklist: encryptedChecklist,
      coachNotes: sessionData.coachNotes ? encrypt(sessionData.coachNotes) : undefined,
      emailSent: false
    };

    loggerWithContext.debug('AI', 'Sesión preparada para guardar', {
      sessionId,
      weekCount: newSession.weeks.length,
      checklistCount: newSession.checklist.length
    });

    // Preparar datos de actualización
    const updateData: any = {
      $set: {
        updatedAt: new Date()
      }
    };

    // Verificar si ya existe una sesión para este mes
    const existingSessionIndex = client.aiProgress?.sessions?.findIndex(
      (s: any) => s.monthNumber === monthNumber
    );

    loggerWithContext.debug('AI', 'Buscando sesión existente para el mes', {
      monthNumber,
      hasAIProgress: !!client.aiProgress,
      sessionsCount: client.aiProgress?.sessions?.length || 0,
      existingSessionIndex
    });

    if (!client.aiProgress || existingSessionIndex === -1) {
      // Primera vez para este mes: crear estructura
      updateData.$set['aiProgress'] = {
        clientId,
        currentSessionId: sessionId,
        sessions: [newSession],
        overallProgress: 0,
        lastEvaluation: new Date(),
        nextEvaluation: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        metrics: {
          nutritionAdherence: 0,
          exerciseConsistency: 0,
          habitFormation: 0
        }
      };

      loggerWithContext.info('AI', 'Creando nueva sesión para mes', { monthNumber });
    } else {
      // Reemplazar la sesión existente para este mes
      const updatedSessions = [...client.aiProgress.sessions];
      updatedSessions[existingSessionIndex] = newSession;

      updateData.$set['aiProgress.sessions'] = updatedSessions;
      updateData.$set['aiProgress.currentSessionId'] = sessionId;
      updateData.$set['aiProgress.lastEvaluation'] = new Date();
      updateData.$set['aiProgress.nextEvaluation'] = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      loggerWithContext.info('AI', 'Reemplazando sesión existente', {
        monthNumber,
        oldSessionId: client.aiProgress.sessions[existingSessionIndex].sessionId,
        newSessionId: sessionId
      });
    }

    const result = await healthForms.updateOne(
      { _id: new ObjectId(clientId) },
      updateData
    );

    loggerWithContext.debug('AI', 'Resultado de actualización en BD', {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount
    });

    if (result.modifiedCount === 0 && result.upsertedCount === 0) {
      loggerWithContext.error('AI', 'No se pudo guardar la sesión importada en BD');
      throw new Error('No se pudo guardar la sesión importada en la base de datos');
    }

    loggerWithContext.info('AI', '✅ Sesión importada exitosamente', {
      sessionId,
      monthNumber
    });

    return true;

  } catch (error: any) {
    loggerWithContext.error('AI', '💥 Error importando sesión', error);

    // Propagar error específico
    if (error.message.includes('La sesión debe incluir')) {
      throw error;
    }

    return false;
  }
}

/**
 * Actualiza el plan semanal (checklist) y re-ejecuta Fase 3 para regenerar la lista de compras.
 * Flujo:
 *   1. Encripta y persiste el checklist editado en MongoDB
 *   2. Extrae el weeklyPlan (7 días × 3 comidas) del checklist
 *   3. Ejecuta Fase 3 (Asistente Logístico) sobre el weeklyPlan
 *   4. Encripta la nueva shoppingList y la persiste en weeks[weekIndex].nutrition.shoppingList
 *   5. Devuelve la sesión desencriptada con la nueva lista de compras
 */
async function updateWeeklyPlanAndShoppingList(
  clientId: string,
  sessionId: string,
  checklistItems: ChecklistItem[],
  weekNumber: number,
  requestId: string
): Promise<any> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  loggerWithContext.info('AI', '📋 Iniciando actualización de plan semanal + Fase 3', {
    sessionId,
    itemCount: checklistItems?.length || 0,
    weekNumber,
  });

  try {
    if (!checklistItems || checklistItems.length === 0) {
      throw new Error('No se recibieron items del plan semanal para actualizar');
    }

    const healthForms = await getHealthFormsCollection();

    // 1. Obtener cliente y sesión
    const client = await healthForms.findOne({
      _id: new ObjectId(clientId),
      'aiProgress.sessions.sessionId': sessionId,
    });

    if (!client || !client.aiProgress) {
      throw new Error('Cliente o sesión no encontrada');
    }

    const sessionIndex = client.aiProgress.sessions.findIndex(
      (s: any) => s.sessionId === sessionId
    );
    if (sessionIndex === -1) throw new Error('Sesión no encontrada');

    const session = client.aiProgress.sessions[sessionIndex];
    const weekIndex = session.weeks.findIndex((w: any) => w.weekNumber === weekNumber);
    if (weekIndex === -1) throw new Error('Semana no encontrada');

    // 2. Encriptar y persistir el checklist editado
    const encryptedChecklistItems: ChecklistItem[] = checklistItems.map((item) => ({
      ...item,
      description: encrypt(item.description),
      details: item.details
        ? {
            ...item.details,
            recipe: item.details.recipe
              ? {
                  ...item.details.recipe,
                  ingredients: item.details.recipe.ingredients.map((ing) => ({
                    name: encrypt(ing.name),
                    quantity: encrypt(ing.quantity),
                    notes: ing.notes ? encrypt(ing.notes) : undefined,
                  })),
                  preparation: encrypt(item.details.recipe.preparation),
                  tips: item.details.recipe.tips ? encrypt(item.details.recipe.tips) : undefined,
                }
              : undefined,
            frequency: item.details.frequency ? encrypt(item.details.frequency) : undefined,
            duration: item.details.duration ? encrypt(item.details.duration) : undefined,
            equipment: item.details.equipment?.map((eq) => encrypt(eq)),
          }
        : undefined,
    }));

    await healthForms.updateOne(
      {
        _id: new ObjectId(clientId),
        'aiProgress.sessions.sessionId': sessionId,
      },
      {
        $set: {
          'aiProgress.sessions.$.checklist': encryptedChecklistItems,
          'aiProgress.sessions.$.updatedAt': new Date(),
          'aiProgress.lastEvaluation': new Date(),
          updatedAt: new Date(),
        },
      }
    );

    // 3. Extraer weeklyPlan del checklist desencriptado
    const dayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const mealTypeMap: Record<string, 'breakfast' | 'lunch' | 'dinner'> = {
      desayuno: 'breakfast',
      almuerzo: 'lunch',
      cena: 'dinner',
    };

    const weeklyPlan = dayNames.map((day) => {
      const dayItems = checklistItems.filter(
        (item) => item.category === 'nutrition' && item.weekNumber === weekNumber && item.description.startsWith(day)
      );
      return {
        day,
        breakfast: dayItems.find((i) => i.type === 'desayuno')?.description.split(': ').slice(1).join(': ') || '',
        lunch: dayItems.find((i) => i.type === 'almuerzo')?.description.split(': ').slice(1).join(': ') || '',
        dinner: dayItems.find((i) => i.type === 'cena')?.description.split(': ').slice(1).join(': ') || '',
      };
    });

    loggerWithContext.info('AI', '📋 WeeklyPlan extraído para Fase 3', {
      daysWithMeals: weeklyPlan.filter((d) => d.breakfast || d.lunch || d.dinner).length,
    });

    // 4. Ejecutar Fase 3 (Asistente Logístico) para regenerar la lista de compras
    const shoppingListOutput = await generateShoppingListFromWeeklyPlan(weeklyPlan);

    // 5. Encriptar la nueva shoppingList
    const encryptedShoppingList = shoppingListOutput.shoppingList.map((item) => ({
      item: encrypt(item.item),
      quantity: encrypt(item.quantity),
      priority: item.priority,
    }));

    // 6. Persistir la shoppingList en la semana correspondiente
    const updatePath = `aiProgress.sessions.${sessionIndex}.weeks.${weekIndex}.nutrition.shoppingList`;
    await healthForms.updateOne(
      { _id: new ObjectId(clientId) },
      { $set: { [updatePath]: encryptedShoppingList } }
    );

    // 7. Obtener sesión actualizada y devolverla desencriptada
    const updatedClient = await healthForms.findOne({ _id: new ObjectId(clientId) });
    if (!updatedClient?.aiProgress) throw new Error('No se pudo obtener el cliente actualizado');

    const updatedSession = updatedClient.aiProgress.sessions[sessionIndex];
    const decryptedSession = decryptAISessionCompletely(updatedSession);

    loggerWithContext.info('AI', '✅ Plan semanal + Fase 3 completado exitosamente', {
      shoppingListItemCount: encryptedShoppingList.length,
    });

    return {
      success: true,
      data: {
        session: decryptedSession,
        shoppingList: shoppingListOutput.shoppingList,
      },
    };
  } catch (error: any) {
    loggerWithContext.error('AI', '💥 Error en updateWeeklyPlanAndShoppingList', error);
    return {
      success: false,
      // SEC (A10): mensaje genérico, detalle solo en logs
      message: 'Error al actualizar el plan semanal y regenerar la lista de compras',
    };
  }
}

async function generateShoppingList(
  clientId: string,
  sessionId: string,
  weekNumber: number,
  requestId: string
): Promise<any> {
  const loggerWithContext = logger.withContext({ requestId, clientId });

  try {
    const healthForms = await getHealthFormsCollection();
    const client = await healthForms.findOne({ _id: new ObjectId(clientId) });

    if (!client || !client.aiProgress) {
      throw new Error('Cliente no encontrado');
    }

    const sessionIndex = client.aiProgress.sessions.findIndex((s: any) => s.sessionId === sessionId);
    if (sessionIndex === -1) throw new Error('Sesión no encontrada');

    const session = client.aiProgress.sessions[sessionIndex];
    const weekIndex = session.weeks.findIndex((w: any) => w.weekNumber === weekNumber);
    if (weekIndex === -1) throw new Error('Semana no encontrada');

    // Obtener items de nutrición de la semana y desencriptarlos
    const nutritionItems = session.checklist
      .filter((item: any) => item.weekNumber === weekNumber && item.category === 'nutrition')
      .map((item: any) => ({
        ...item,
        description: safeDecrypt(item.description),
        recipeId: item.recipeId,
        frequency: item.frequency || 1,
        details: item.details ? {
          recipe: item.details.recipe ? {
            ingredients: item.details.recipe.ingredients.map((ing: any) => ({
              name: safeDecrypt(ing.name),
              quantity: safeDecrypt(ing.quantity),
              notes: ing.notes ? safeDecrypt(ing.notes) : undefined
            })),
            preparation: safeDecrypt(item.details.recipe.preparation),
            tips: item.details.recipe.tips ? safeDecrypt(item.details.recipe.tips) : undefined
          } : undefined
        } : undefined
      }));

    console.log('nutritionItems:', JSON.stringify(nutritionItems, null, 2));
    // Llamar al servicio con los items completos
    const shoppingList = await AIService.generateShoppingListFromItems(nutritionItems);
    console.log('shoppingList generada:', shoppingList);

    // Actualizar la semana con la nueva lista
    const updatePath = `aiProgress.sessions.${sessionIndex}.weeks.${weekIndex}.nutrition.shoppingList`;
    const result = await healthForms.updateOne(
      { _id: new ObjectId(clientId) },
      { $set: { [updatePath]: shoppingList } }
    );
    console.log('Resultado de update:', result);

    if (result.matchedCount === 0) {
      throw new Error('Cliente no encontrado');
    }

    return { success: true, shoppingList };
  } catch (error: any) {
    loggerWithContext.error('AI', 'Error generando lista de compras', error);
    // SEC (A10): mensaje genérico, detalle solo en logs
    return { success: false, message: 'Error generando la lista de compras' };
  }
}
