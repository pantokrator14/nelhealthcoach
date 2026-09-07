// apps/api/src/app/api/video/send-invite/route.ts
//
// POST: Envía el email de invitación a la videollamada al cliente.
// Genera el enlace con token temporal y lo incluye en el email.
// Solo accesible por el coach autenticado.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { generateClientSessionLink, getVideoSession } from '@/app/lib/video-service';
import { EmailService } from '@/app/lib/email-service';
import { getHealthFormsCollection, connectToDatabase } from '@/app/lib/database';
import { decrypt } from '@/app/lib/encryption';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';

interface SendInviteRequest {
  clientId: string;
  sessionId: string;
}

async function postHandler(request: NextRequest): Promise<NextResponse> {
  try {
    // Auth — coach autenticado
    const auth = requireCoachAuth(request);

    const body = (await request.json()) as SendInviteRequest;

    if (!body.clientId || !body.sessionId) {
      return NextResponse.json(
        { success: false, message: 'clientId y sessionId son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Obtener datos del cliente
    const collection = await getHealthFormsCollection();
    const doc = await collection.findOne(
      { _id: new ObjectId(body.clientId) },
      { projection: { personalData: 1, videoSessions: 1 } }
    );

    if (!doc) {
      return NextResponse.json(
        { success: false, message: 'Cliente no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Obtener email y nombre del cliente
    const rawPersonal = doc.personalData as Record<string, unknown> | undefined;
    const clientEmail = rawPersonal?.email
      ? decrypt(rawPersonal.email as string)
      : '';
    const clientName = rawPersonal?.name
      ? decrypt(rawPersonal.name as string)
      : 'Cliente';

    if (!clientEmail) {
      return NextResponse.json(
        { success: false, message: 'El cliente no tiene email registrado', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Obtener la sesión de video
    const session = await getVideoSession(body.clientId, body.sessionId);
    if (!session) {
      return NextResponse.json(
        { success: false, message: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND'},
        { status: 404 }
      );
    }

    // Generar enlace para el cliente
    const { joinLink } = generateClientSessionLink(
      body.clientId,
      body.sessionId,
      clientEmail
    );

    // Guardar el enlace en la sesión
    await collection.updateOne(
      { _id: new ObjectId(body.clientId) },
      {
        $set: {
          'videoSessions.$[session].clientJoinLink': joinLink,
          updatedAt: new Date(),
        },
      } as Record<string, unknown>,
      {
        arrayFilters: [{ 'session.sessionId': body.sessionId }],
      }
    );

    // Enviar email con Resend
    const emailService = EmailService.getInstance();

    // Usar la zona horaria con la que se agendó la sesión; fallback a UTC
    const timezone = session.timezone || 'UTC';

    const scheduledDate = new Date(session.scheduledAt);
    const timeString = scheduledDate.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    });

    const emailSent = await emailService.sendSessionInviteEmail(clientEmail, {
      clientName,
      sessionNumber: session.sessionNumber,
      scheduledDate,
      scheduledTime: timeString,
      durationMinutes: session.durationMinutes,
      joinLink,
      timeZone: timezone,
    });

    logger.info('VIDEO', 'Session invite email sent', {
      clientId: body.clientId,
      sessionId: body.sessionId,
      emailSent,
    });

    let coachEmailSent = false;

    // También enviar notificación al coach con enlace para unirse
    try {
      const coachEmail = auth.email;  // reuse auth from earlier

      if (coachEmail) {
        // Obtener colección de coaches para el nombre
        const { db } = await connectToDatabase();
        const coachDoc = await db.collection('coaches').findOne(
          { emailHash: crypto.createHash('sha256').update(coachEmail.toLowerCase().trim()).digest('hex') }
        );

        // Generar un join link para el coach (reutilizando el mismo link)
        const coachJoinLink = joinLink;

        coachEmailSent = await emailService.sendCoachSessionNotification(coachEmail, {
          clientName,
          sessionNumber: session.sessionNumber,
          scheduledDate,
          scheduledTime: timeString,
          durationMinutes: session.durationMinutes,
          joinLink: coachJoinLink,
          dashboardUrl: `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/dashboard/clients/${body.clientId}`,
          timeZone: timezone,
        });

        logger.info('VIDEO', 'Coach notification email sent', {
          coachEmail,
          sessionId: body.sessionId,
          coachEmailSent,
        });
      }
    } catch (coachError: unknown) {
      logger.warn('VIDEO', 'Failed to send coach notification', coachError as Error);
    }

    return NextResponse.json({
      success: true,
      data: {
        emailSent,
        coachEmailSent,
        joinLink,
        clientEmail,
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';

    if (errorMessage.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    logger.error('VIDEO', 'Failed to send session invite', error as Error);

    return NextResponse.json(
      {
        success: false,
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && { detail: errorMessage }),
        code: 'INTERNAL',
      },
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
