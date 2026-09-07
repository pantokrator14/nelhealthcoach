// apps/api/src/app/api/video/transcription-ready/route.ts
//
// POST: Callback de Deepgram con el resultado de la transcripción
// de una grabación de videollamada.
//
// Flujo completo:
// 1. Deepgram procesa el audio y llama a este endpoint
// 2. Si la transcripción es exitosa → guarda en S3 + MongoDB, genera resumen con Gemini
// 3. Si la transcripción está vacía → REINTENTO AUTOMÁTICO (1 vez) reenviando a Deepgram
// 4. Si el reintento automático también falla → marca como 'failed' con mensaje explicativo
// 5. Si hay error de metadata → rechaza silenciosamente (no podemos hacer nada)
//
// El reintento automático ocurre ANTES de que el coach vea el botón "Reintentar Transcripción".
// El botón manual es el SEGUNDO nivel de reintento (después de que el auto-retry falló).

import { NextRequest, NextResponse } from 'next/server';
import { getHealthFormsCollection } from '@/app/lib/database';
import { encrypt, encryptFileObject } from '@/app/lib/encryption';
import { uploadTextToS3 } from '@/app/lib/s3';
import { logger } from '@/app/lib/logger';
import { ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { callGeminiAPI } from '@/app/lib/agents/utils/llm';
import { apiHandler } from '@/app/lib/apiHandler';
import {
  submitTranscriptionRequest,
  buildCallbackUrl,
  MAX_AUTO_RETRIES,
} from '@/app/lib/deepgram';
import type { VideoSession } from '../../../../../../../packages/types';

// ─────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────

async function postHandler(request: NextRequest): Promise<NextResponse> {
  // Declaradas fuera del try para accesibilidad en catch
  let clientId: string | undefined | null;
  let sessionId: string | undefined | null;
  let sessionNumber: number;
  let requestId: string | undefined;

  try {
    const body = (await request.json()) as Record<string, unknown>;

    requestId = (body.request_id as string) || 'unknown';
    const metadata = body.metadata as Record<string, unknown> | undefined;
    const results = body.results as Record<string, unknown> | undefined;

    clientId = metadata?.clientId as string | undefined;
    sessionId = metadata?.sessionId as string | undefined;
    sessionNumber = Number(metadata?.sessionNumber) || 1;

    logger.info('TRANSCRIPTION', 'Deepgram callback received', {
      requestId,
      clientId: clientId || 'unknown',
      sessionId: sessionId || 'unknown',
      isRetry: metadata?.isRetry === 'true' || metadata?.isRetry === 'manual',
    });

    // ── Extraer transcripción ──
    const channels = results?.channels as Array<Record<string, unknown>> | undefined;
    const alternatives = channels?.[0]?.alternatives as Array<Record<string, unknown>> | undefined;
    const transcript = alternatives?.[0]?.transcript as string | undefined;
    const confidence = (alternatives?.[0]?.confidence as number) ?? 0;
    const audioDuration = (results?.duration as number) ?? 0;

    // ── VALIDACIÓN 1: Transcripción vacía → reintento automático ──
    if (!transcript || transcript.trim().length === 0) {
      logger.warn('TRANSCRIPTION', 'Empty transcript received — evaluating auto-retry', {
        requestId,
        clientId: clientId || 'unknown',
        sessionId: sessionId || 'unknown',
        confidence,
        audioDuration,
      });

      if (clientId && sessionId) {
        await handleEmptyTranscript(clientId, sessionId, sessionNumber, requestId);
      }

      // Siempre respondemos 200 a Deepgram (incluso si falló el manejo)
      return NextResponse.json({
        success: false,
        message: 'Transcripción vacía — se aplicó reintento automático si aplicaba',
      });
    }

    // ── VALIDACIÓN 2: Metadata incompleta ──
    if (!clientId || !sessionId) {
      logger.warn('TRANSCRIPTION', 'Missing clientId or sessionId in Deepgram callback metadata', {
        requestId,
        metadata,
      });
      return NextResponse.json(
        { success: false, message: 'Metadata incompleta: falta clientId o sessionId', code: 'VALIDATION'},
        { status: 200 } // 200 para que Deepgram no reintente
      );
    }

    // ── Transcripción exitosa: procesar y guardar ──

    logger.info('TRANSCRIPTION', 'Transcription successful, processing', {
      requestId,
      clientId,
      sessionId,
      sessionNumber,
      confidence: Math.round(confidence * 100),
      audioDuration: Math.round(audioDuration),
      transcriptLength: transcript.length,
    });

    // Generar nombre de archivo para la transcripción
    const transcriptionId = `tr_${uuidv4().slice(0, 8)}`;
    const fileName = `transcripcion_sesion_${sessionNumber}_${Date.now()}.txt`;
    const s3Key = `clients/${clientId}/transcriptions/${fileName}`;

    // Subir transcripción a S3 (no crítico — si falla, igual guardamos en MongoDB)
    let s3Url = '';
    try {
      s3Url = await uploadTextToS3(s3Key, transcript, 'text/plain; charset=utf-8');
      logger.info('TRANSCRIPTION', 'Transcription uploaded to S3', { s3Key, clientId, sessionId });
    } catch (s3Error: unknown) {
      logger.error('TRANSCRIPTION', 'Failed to upload transcription to S3 (non-critical)', s3Error as Error, undefined, {
        clientId,
        sessionId,
        s3Key,
      });
    }

    // Guardar en MongoDB
    const collection = await getHealthFormsCollection();

    const transcriptionDoc = {
      transcriptionId,
      sessionId,
      sessionNumber,
      fullText: encrypt(transcript),
      summary: encrypt(''), // Se llenará después con Gemini
      agreements: encrypt(''), // Se llenará después con Gemini
      createdAt: new Date(),
      txtFileS3Key: encrypt(s3Key),
      confidence,
      audioDurationSeconds: audioDuration,
    };

    // Crear entrada para medicalData.documents (visible en Dashboard > Documentos Médicos)
    const documentEntry = encryptFileObject({
      url: s3Url || '',
      key: s3Key,
      name: fileName,
      type: 'text/plain',
      size: Buffer.byteLength(transcript, 'utf-8'),
      uploadedAt: new Date().toISOString(),
    });

    await collection.updateOne(
      { _id: new ObjectId(clientId) },
      {
        $push: {
          transcriptions: transcriptionDoc,
          'medicalData.processedDocuments': {
            title: encrypt(`Seguimiento #${sessionNumber}`),
            content: encrypt(transcript),
            metadata: {
              documentType: 'transcription',
              extractionStatus: 'completed',
              source: 'deepgram',
            },
            confidence: Math.round(confidence * 100),
            processedAt: new Date(),
            pageCount: 1,
            language: 'es',
          },
          'medicalData.documents': documentEntry,
        },
        $set: {
          updatedAt: new Date(),
        },
      } as Record<string, unknown>
    );

    // Marcar transcripción como completada en la sesión de video
    await collection.updateOne(
      { _id: new ObjectId(clientId) },
      {
        $set: {
          'videoSessions.$[session].transcriptStatus': 'completed',
          'videoSessions.$[session].transcriptError': '',
          updatedAt: new Date(),
        },
      } as Record<string, unknown>,
      {
        arrayFilters: [{ 'session.sessionId': sessionId }],
      }
    );

    logger.info('TRANSCRIPTION', 'Transcription saved to MongoDB successfully', {
      clientId,
      sessionId,
      transcriptionId,
      transcriptLength: transcript.length,
    });

    // ── Resumir con Gemini (no crítico — si falla, la transcripción ya está guardada) ──

    let summaryText = '';
    let agreementsText = '';

    try {
      const prompt = `Eres un asistente especializado en resumir sesiones de coaching de salud. 
Analiza la siguiente transcripción de una videollamada entre un coach de salud y su cliente.

Extrae y devuelve ÚNICAMENTE un JSON válido con esta estructura:
{
  "summary": "Resumen de 2-3 párrafos de los temas principales tratados en la sesión",
  "agreements": "Acuerdos alcanzados, cambios en objetivos, próximos pasos concretos acordados entre coach y cliente",
  "keyPoints": ["Punto clave 1", "Punto clave 2", ...]
}

TRANSCRIPCIÓN:
${transcript.slice(0, 12000)}

Responde solo con el JSON, sin explicaciones adicionales.`;

      const geminiResult = await callGeminiAPI({
        userPrompt: prompt,
        temperature: 0.3,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
      });

      const jsonMatch = geminiResult.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          summary: string;
          agreements: string;
        };
        summaryText = parsed.summary || '';
        agreementsText = parsed.agreements || '';
      }

      // Guardar el resumen en MongoDB
      const updateFields: Record<string, unknown> = {
        'transcriptions.$[tr].summary': encrypt(summaryText),
        'transcriptions.$[tr].agreements': encrypt(agreementsText),
        updatedAt: new Date(),
      };

      await collection.updateOne(
        { _id: new ObjectId(clientId) },
        { $set: updateFields },
        { arrayFilters: [{ 'tr.transcriptionId': transcriptionId }] }
      );

      logger.info('TRANSCRIPTION', 'Transcription summarized with Gemini', {
        clientId,
        sessionId,
        transcriptionId,
        summaryLength: summaryText.length,
        agreementsLength: agreementsText.length,
      });
    } catch (geminiError: unknown) {
      logger.warn('TRANSCRIPTION', 'Gemini summarization failed (non-critical — transcript already saved)', {
        error: geminiError instanceof Error ? geminiError.message : String(geminiError),
        clientId,
        sessionId,
        transcriptionId,
      });
    }

    return NextResponse.json({
      success: true,
      data: { transcriptionId, s3Key },
    });
  } catch (error: unknown) {
    logger.error('TRANSCRIPTION', 'Fatal error processing Deepgram callback', error as Error, undefined, {
      requestId: requestId || 'unknown',
      clientId: clientId || 'unknown',
      sessionId: sessionId || 'unknown',
    });

    // Intentar marcar la transcripción como fallada si tenemos los datos
    if (typeof clientId !== 'undefined' && typeof sessionId !== 'undefined' && clientId && sessionId) {
      try {
        const failCollection = await getHealthFormsCollection();
        const errorMessage = error instanceof Error ? error.message : 'Error desconocido';

        await failCollection.updateOne(
          { _id: new ObjectId(clientId) },
          {
            $set: {
              'videoSessions.$[session].transcriptStatus': 'failed',
              'videoSessions.$[session].transcriptError': errorMessage,
              updatedAt: new Date(),
            },
          } as Record<string, unknown>,
          { arrayFilters: [{ 'session.sessionId': sessionId }] }
        );

        logger.info('TRANSCRIPTION', 'Marked transcript as failed after fatal error', {
          clientId,
          sessionId,
          error: errorMessage,
        });
      } catch (dbError: unknown) {
        logger.error('TRANSCRIPTION', 'Failed to mark transcript as failed in DB', dbError as Error);
      }
    }

    return NextResponse.json(
      { success: false, message: 'Error processing transcription callback', code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);

// ─────────────────────────────────────────────
// Reintento automático
// ─────────────────────────────────────────────

/**
 * Maneja el caso de transcripción vacía de Deepgram.
 *
 * Estrategia de reintento:
 * 1. Busca la sesión de video en MongoDB para obtener recordingS3Key y retryCount
 * 2. Si retryCount < MAX_AUTO_RETRIES (1):
 *    - Reenvía la misma grabación a Deepgram
 *    - Incrementa transcriptRetryCount a 1
 *    - Mantiene transcriptStatus como 'pending' (nunca llega a 'failed')
 * 3. Si retryCount >= MAX_AUTO_RETRIES:
 *    - Marca como 'failed' con mensaje explicativo detallado
 *    - El coach verá el botón "Reintentar Transcripción" para reintento manual
 */
async function handleEmptyTranscript(
  clientId: string,
  sessionId: string,
  sessionNumber: number,
  deepgramRequestId: string
): Promise<void> {
  try {
    const collection = await getHealthFormsCollection();

    // Buscar la sesión para obtener recordingS3Key y retryCount
    const doc = await collection.findOne(
      { _id: new ObjectId(clientId) },
      { projection: { videoSessions: 1 } }
    );

    if (!doc) {
      logger.warn('TRANSCRIPTION', 'Client not found for empty transcript handling', {
        clientId,
        sessionId,
      });
      await markAsFailed(clientId, sessionId, 'Cliente no encontrado en la base de datos.');
      return;
    }

    const sessions = doc.videoSessions as VideoSession[];
    const session = sessions.find((s) => s.sessionId === sessionId);

    if (!session) {
      logger.warn('TRANSCRIPTION', 'Session not found for empty transcript handling', {
        clientId,
        sessionId,
      });
      await markAsFailed(clientId, sessionId, 'Sesión de video no encontrada en la base de datos.');
      return;
    }

    const retryCount = session.transcriptRetryCount ?? 0;
    const recordingUrl = session.recordingS3Key;
    const roomName = session.roomName;

    logger.info('TRANSCRIPTION', 'Auto-retry evaluation', {
      clientId,
      sessionId,
      retryCount,
      maxRetries: MAX_AUTO_RETRIES,
      hasRecording: !!recordingUrl,
    });

    // ¿Podemos reintentar automáticamente?
    if (retryCount < MAX_AUTO_RETRIES && recordingUrl) {
      try {
        const callbackUrl = buildCallbackUrl();

        // metadata.isRetry = 'true' le indica al próximo callback que es un reintento
        const result = await submitTranscriptionRequest(recordingUrl, callbackUrl, {
          clientId,
          sessionId,
          sessionNumber: String(sessionNumber),
          roomName: roomName || '',
          isRetry: 'true',
        });

        // Actualizar contador de reintentos y mantener status como 'pending'
        await collection.updateOne(
          { _id: new ObjectId(clientId) },
          {
            $set: {
              'videoSessions.$[session].transcriptStatus': 'pending',
              'videoSessions.$[session].transcriptRetryCount': retryCount + 1,
              'videoSessions.$[session].transcriptError':
                `Intento ${retryCount + 1}: Deepgram devolvió transcripción vacía. Reintentando...`,
              updatedAt: new Date(),
            },
          } as Record<string, unknown>,
          { arrayFilters: [{ 'session.sessionId': sessionId }] }
        );

        logger.info('TRANSCRIPTION', 'Auto-retry submitted to Deepgram', {
          clientId,
          sessionId,
          requestId: result.requestId,
          attemptNumber: retryCount + 1,
        });

        // ✅ Importante: NO marcamos como 'failed'. Dejamos 'pending' para que
        // el polling del Dashboard detecte el cambio cuando Deepgram responda.
        return;
      } catch (retryError: unknown) {
        // El reintento automático falló (ej: Deepgram API error)
        const errorMsg = retryError instanceof Error ? retryError.message : 'Error desconocido en el reintento automático';

        logger.error('TRANSCRIPTION', 'Auto-retry submission failed', retryError as Error, undefined, {
          clientId,
          sessionId,
          attemptNumber: retryCount + 1,
        });

        await markAsFailed(clientId, sessionId, errorMsg);
        return;
      }
    }

    // ── No podemos reintentar más ──

    if (!recordingUrl) {
      // No hay grabación para reintentar
      await markAsFailed(
        clientId,
        sessionId,
        'La grabación de la videollamada no está disponible en el servidor. ' +
        'Esto puede ocurrir si el webhook de LiveKit no recibió el archivo de grabación. ' +
        'Para futuras sesiones, verifica que la grabación automática esté configurada correctamente.'
      );
      return;
    }

    // Ya agotamos los reintentos automáticos
    const failureReason = retryCount >= MAX_AUTO_RETRIES
      ? `La transcripción devolvió texto vacío después de ${MAX_AUTO_RETRIES + 1} intentos (original + ${MAX_AUTO_RETRIES} reintento(s)).\n\n` +
        'Posibles causas:\n' +
        '• El audio tiene mucho ruido de fondo que impide el reconocimiento de voz\n' +
        '• Varias personas hablando al mismo tiempo (Deepgram no puede separar las voces)\n' +
        '• El volumen de la grabación es muy bajo\n' +
        '• Los participantes hablaron en un idioma diferente al español\n' +
        '• La grabación contiene principalmente silencios o música de fondo\n\n' +
        'Puedes intentar:\n' +
        '• Usar el botón "Reintentar Transcripción" en el Dashboard para un intento manual\n' +
        '• En la próxima videollamada, usar un micrófono de mejor calidad\n' +
        '• Buscar un lugar silencioso sin eco ni ruido ambiental\n' +
        '• Hablar claro y evitar interrupciones'
      : 'La grabación no está disponible para reintentar.';

    await markAsFailed(clientId, sessionId, failureReason);

  } catch (error: unknown) {
    // Error inesperado en nuestra lógica de reintento
    logger.error('TRANSCRIPTION', 'Unexpected error in auto-retry handler', error as Error, undefined, {
      clientId,
      sessionId,
    });

    await markAsFailed(
      clientId,
      sessionId,
      'Error interno al procesar el reintento automático. Usa el botón "Reintentar Transcripción" en el Dashboard.'
    );
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Marca la transcripción como fallida en MongoDB.
 * Centraliza la actualización para mantener consistencia.
 */
async function markAsFailed(
  clientId: string,
  sessionId: string,
  errorMessage: string
): Promise<void> {
  try {
    const collection = await getHealthFormsCollection();
    await collection.updateOne(
      { _id: new ObjectId(clientId) },
      {
        $set: {
          'videoSessions.$[session].transcriptStatus': 'failed',
          'videoSessions.$[session].transcriptError': errorMessage,
          updatedAt: new Date(),
        },
      } as Record<string, unknown>,
      { arrayFilters: [{ 'session.sessionId': sessionId }] }
    );

    logger.info('TRANSCRIPTION', 'Marked transcript as failed', {
      clientId,
      sessionId,
      errorSummary: errorMessage.slice(0, 120),
    });
  } catch (dbError: unknown) {
    logger.error('TRANSCRIPTION', 'Failed to mark transcript as failed', dbError as Error, undefined, {
      clientId,
      sessionId,
    });
  }
}
