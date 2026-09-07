// apps/api/src/app/api/video/rooms/[sessionId]/retry-transcription/route.ts
//
// POST: Reintenta la transcripción de una grabación de videollamada.
// Busca la sesión por sessionId, obtiene la URL de la grabación
// almacenada (recordingS3Key) y la reenvía a Deepgram.
//
// Diferencias con el reintento automático (que ocurre en transcription-ready):
// - Este endpoint es MANUAL: lo invoca el coach desde el Dashboard
// - El reintento automático ocurre en el callback de Deepgram antes de marcar "failed"
// - Ambos usan el mismo servicio compartido (lib/deepgram.ts)
//
// Seguridad: Requiere autenticación del coach.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { getHealthFormsCollection } from '@/app/lib/database';
import { ObjectId } from 'mongodb';
import { logger } from '@/app/lib/logger';
import {
  isDeepgramConfigured,
  submitTranscriptionRequest,
  buildCallbackUrl,
  explainTranscriptionError,
} from '@/app/lib/deepgram';
import { apiHandler } from '@/app/lib/apiHandler';
import type { VideoSession } from '../../../../../../../../../packages/types';

// ─────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────

async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<NextResponse> {
  let sessionId: string | undefined;

  try {
    // Verificar autenticación del coach
    const auth = requireCoachAuth(request);

    sessionId = (await params).sessionId;

    if (!sessionId) {
      return NextResponse.json(
        { success: false, message: 'sessionId es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Verificar que Deepgram esté configurado
    if (!isDeepgramConfigured()) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Deepgram no está configurado. El administrador debe configurar la variable DEEPGRAM_API_KEY.',
          code: 'INTERNAL',
        },
        { status: 500 }
      );
    }

    // Buscar la sesión de video para obtener clientId y recordingS3Key
    const collection = await getHealthFormsCollection();
    const doc = await collection.findOne(
      { 'videoSessions.sessionId': sessionId },
      { projection: { _id: 1, videoSessions: 1 } }
    );

    if (!doc) {
      return NextResponse.json(
        { success: false, message: 'No se encontró una sesión de video con ese ID.', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    const sessions = doc.videoSessions as VideoSession[];
    const session = sessions.find((s) => s.sessionId === sessionId);

    if (!session) {
      return NextResponse.json(
        { success: false, message: 'Sesión de video no encontrada en el registro.', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    const clientId = doc._id.toString();

    // Verificar que tengamos la URL de la grabación
    if (!session.recordingS3Key) {
      return NextResponse.json(
        {
          success: false,
          message:
            'No hay grabación disponible para esta sesión. ' +
            'La videollamada no fue grabada o el webhook de egress no se completó. ' +
            'Para futuras sesiones, asegúrate de que la grabación automática esté habilitada en LiveKit.',
          code: 'VALIDATION',
        },
        { status: 400 }
      );
    }

    const recordingUrl = session.recordingS3Key;
    const roomName = session.roomName;
    const sessionNumber = session.sessionNumber ?? 1;
    const previousRetryCount = session.transcriptRetryCount ?? 0;

    logger.info('TRANSCRIPTION', 'Manual retry requested by coach', {
      sessionId,
      clientId,
      roomName,
      previousRetryCount,
    });

    // Construir callback URL
    const callbackUrl = buildCallbackUrl();

    // Enviar a Deepgram (el metadata indica que es un reintento manual)
    const result = await submitTranscriptionRequest(recordingUrl, callbackUrl, {
      clientId,
      sessionId,
      sessionNumber: String(sessionNumber),
      roomName,
      isRetry: 'manual',
    });

    logger.info('TRANSCRIPTION', 'Manual retry submitted to Deepgram successfully', {
      requestId: result.requestId,
      sessionId,
      clientId,
    });

    // Marcar transcripción como pendiente nuevamente, incrementar contador de reintentos
    await collection.updateOne(
      { _id: new ObjectId(clientId) },
      {
        $set: {
          'videoSessions.$[session].transcriptStatus': 'pending',
          'videoSessions.$[session].transcriptError': '',
          'videoSessions.$[session].transcriptRetryCount': previousRetryCount + 1,
          updatedAt: new Date(),
        },
      } as Record<string, unknown>,
      { arrayFilters: [{ 'session.sessionId': sessionId }] }
    );

    return NextResponse.json({
      success: true,
      data: {
        requestId: result.requestId,
        message:
          'La transcripción se está procesando nuevamente. ' +
          'Recibirás una notificación cuando esté lista.',
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';

    // Errores de autenticación
    if (errorMessage.includes('Token') || errorMessage.includes('autorizado')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado. Inicia sesión nuevamente.', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    // Errores de Deepgram (mejorados con explicación)
    const explainedMessage = explainTranscriptionError(
      errorMessage,
      true,
      0 // No aplica aquí porque el reintento manual no usa el contador de auto-retry
    );

    logger.error('TRANSCRIPTION', 'Manual retry failed', error as Error, undefined, {
      sessionId: sessionId || 'unknown',
      errorDetail: errorMessage,
    });

    return NextResponse.json(
      {
        success: false,
        message: 'Error al procesar la solicitud',
        ...(process.env.NODE_ENV === 'development' && { detail: errorMessage }),
        code: 'INTERNAL',
      },
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
