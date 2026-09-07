// apps/api/src/app/api/video/test-token/route.ts
//
// POST (solo desarrollo): Genera tokens de prueba para videollamada.
// Crea un room temporal sin persistir en MongoDB.
// Permite que el coach y un "cliente de prueba" se unan a la misma sala.
//
// Seguridad: Solo responde si NODE_ENV !== 'production'.

import { NextRequest, NextResponse } from 'next/server';
import { generateParticipantToken } from '@/app/lib/video-service';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';
import jwt from 'jsonwebtoken';

interface TestTokenRequest {
  roomName: string;
  role: 'coach' | 'client';
  displayName?: string;
}

async function postHandler(request: NextRequest) {
  try {
    // ── Seguridad: solo en desarrollo ──
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { success: false, message: 'Endpoint solo disponible en desarrollo', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    const body = (await request.json()) as TestTokenRequest;

    if (!body.roomName || !body.role) {
      return NextResponse.json(
        { success: false, message: 'roomName y role son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const displayName = body.displayName || (body.role === 'coach' ? 'Coach (test)' : 'Cliente (test)');

    // ── Generar token de LiveKit ──

    const testClientId = 'test_client_dev';
    const testSessionId = `test_session_${Date.now()}`;

    const liveKitToken = await generateParticipantToken({
      roomName: body.roomName,
      participantIdentity: `${body.role}_test_${Date.now()}`,
      participantName: displayName,
      metadata: {
        clientId: testClientId,
        sessionId: testSessionId,
        role: body.role,
        displayName,
      },
      canPublish: true,
    });

    // ── Si es cliente, generar también un sessionToken JWT ──

    let sessionToken: string | undefined;

    if (body.role === 'client') {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        return NextResponse.json(
          { success: false, message: 'JWT_SECRET no está configurado', code: 'INTERNAL'},
          { status: 500 },
        );
      }
      sessionToken = jwt.sign(
        {
          sub: testClientId,
          sessionId: testSessionId,
          email: 'test@nelhealthcoach.dev',
          type: 'client-session',
        },
        secret,
        { expiresIn: '2h' }
      );
    }

    logger.info('VIDEO', 'Test token generated', {
      roomName: body.roomName,
      role: body.role,
    });

    return NextResponse.json({
      success: true,
      data: {
        token: liveKitToken,
        serverUrl: process.env.LIVEKIT_URL,
        sessionToken, // undefined para coach
        roomName: body.roomName,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Error desconocido';
    logger.error('VIDEO', 'Test token generation failed', error as Error);
    return NextResponse.json(
      {
        success: false,
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && { detail: msg }),
        code: 'INTERNAL',
      },
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
