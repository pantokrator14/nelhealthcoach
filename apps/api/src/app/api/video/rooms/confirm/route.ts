// apps/api/src/app/api/video/rooms/confirm/route.ts
//
// POST: Confirma una sesión después del pago y crea la sala en LiveKit.
// Solo accesible por el coach autenticado.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { createVideoSession } from '@/app/lib/video-service';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import PendingSession from '@/app/models/PendingSession';
import { EmailService } from '@/app/lib/email-service';
import { generateCoachSessionNotificationHTML } from '@/app/lib/email-templates';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/video/rooms/confirm
 *
 * Body: { pendingSessionId }
 *
 * El coach confirma la sesión después de que el cliente pagó.
 * Crea la sala en LiveKit, envía el link "Unirse" al cliente
 * y notifica al coach.
 */
async function postHandler(request: NextRequest) {
  try {
    const coachPayload = requireCoachAuth(request);

    await connectMongoose();

    const body = await request.json();
    const { pendingSessionId } = body as { pendingSessionId?: string };

    if (!pendingSessionId) {
      return NextResponse.json(
        { success: false, message: 'pendingSessionId es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const pending = await PendingSession.findById(pendingSessionId);

    if (!pending) {
      return NextResponse.json(
        { success: false, message: 'Sesión pendiente no encontrada', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (pending.status !== 'paid') {
      return NextResponse.json(
        { success: false, message: 'El pago de esta sesión no ha sido confirmado', code: 'VALIDATION'},
        { status: 402 }
      );
    }

    if (pending.proposedDate < new Date()) {
      await PendingSession.updateOne(
        { _id: pending._id },
        { $set: { status: 'cancelled' } }
      );
      return NextResponse.json(
        { success: false, message: 'La fecha propuesta ya pasó. Crea una nueva solicitud.', code: 'VALIDATION'},
        { status: 410 }
      );
    }

    // Crear la sala en LiveKit y registrar la sesión
    const result = await createVideoSession(
      pending.clientId,
      pending.proposedDate.toISOString(),
      pending.duration,
      pending.coachNotes || undefined,
      pending.timezone || undefined
    );

    // Marcar la pending session como completada
    await PendingSession.updateOne(
      { _id: pending._id },
      { $set: { status: 'completed' } }
    );

    // Obtener la URL de unión para el cliente
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const { joinLink: joinTokenUrl } = await (await import('@/app/lib/video-service')).generateClientSessionLink(
      pending.clientId,
      result.session.sessionId,
      pending.clientEmail
    );

    // Enviar email con link de unión al cliente
    try {
      const emailService = EmailService.getInstance();
      const dateOpts: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      };
      const formattedDate = pending.proposedDate.toLocaleDateString('es-MX', dateOpts);
      const timeStr = pending.proposedDate.toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      });

      const emailData = {
        clientName: pending.clientName,
        sessionNumber: result.session.sessionNumber,
        scheduledDate: pending.proposedDate,
        scheduledTime: timeStr,
        durationMinutes: pending.duration,
        joinLink: joinTokenUrl,
        timeZone: pending.timezone || undefined,
      };

      const { generateSessionInviteHTML } = await import('@/app/lib/email-templates');

      await emailService.sendEmail({
        to: [pending.clientEmail],
        subject: `📹 Sesión #${result.session.sessionNumber} Confirmada — ${formattedDate} | NELHealthCoach`,
        htmlBody: generateSessionInviteHTML(emailData),
      });
    } catch (emailError) {
      logger.error('VIDEO', 'Error enviando email de confirmación al cliente', emailError as Error);
    }

    // Notificar al coach
    try {
      const emailService = EmailService.getInstance();
      const { default: Coach } = await import('@/app/models/Coach');
      const { decrypt } = await import('@/app/lib/encryption');

      const coach = await Coach.findById(pending.coachId).lean() as Record<string, unknown> | null;
      if (coach) {
        const coachEmail = coach.email ? decrypt(coach.email as string) : null;
        if (coachEmail) {
          const dashboardUrl = `${appUrl}/dashboard/clients/${pending.clientId}`;

          const coachNotifHTML = generateCoachSessionNotificationHTML({
            clientName: pending.clientName,
            sessionNumber: result.session.sessionNumber,
            scheduledDate: pending.proposedDate,
            scheduledTime: pending.proposedDate.toLocaleTimeString('es-MX', {
              hour: '2-digit',
              minute: '2-digit',
            }),
            durationMinutes: pending.duration,
            dashboardUrl,
          });

          await emailService.sendEmail({
            to: [coachEmail],
            subject: `✅ Sesión #${result.session.sessionNumber} confirmada — ${pending.clientName} | NELHealthCoach`,
            htmlBody: coachNotifHTML,
          });
        }
      }
    } catch (emailError) {
      logger.error('VIDEO', 'Error notificando al coach', emailError as Error);
    }

    logger.info('VIDEO', 'Session confirmed and room created', {
      clientId: pending.clientId,
      sessionId: result.session.sessionId,
      roomName: result.roomName,
      pendingSessionId,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          roomName: result.roomName,
          sessionId: result.session.sessionId,
          sessionNumber: result.session.sessionNumber,
          scheduledAt: pending.proposedDate.toISOString(),
          message: 'Sesión confirmada y sala creada exitosamente.',
        },
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';

    if (errorMessage.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    logger.error('VIDEO', 'Failed to confirm session', error as Error);
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
