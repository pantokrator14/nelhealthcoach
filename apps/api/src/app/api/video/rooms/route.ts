// apps/api/src/app/api/video/rooms/route.ts
//
// POST: Crea una solicitud de sesión pendiente de pago.
// El coach selecciona fecha/hora → se crea PendingSession → cliente paga → se crea sala.
// GET: Lista las sesiones pendientes (para que el coach vea estado de pagos).
//
// Solo accesible por el coach autenticado.

import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import PendingSession from '@/app/models/PendingSession';
import { encrypt } from '@/app/lib/encryption';
import { EmailService } from '@/app/lib/email-service';
import { generatePaymentRequestEmailHTML } from '@/app/lib/email-templates';
import { createNotification } from '@/app/lib/create-notification';
import { apiHandler } from '@/app/lib/apiHandler';

interface CreateRoomRequestBody {
  clientId: string;
  clientName: string;
  clientEmail: string;
  scheduledAt: string;
  durationMinutes?: number;
  coachNotes?: string;
  timezone?: string;
}

async function postHandler(request: NextRequest): Promise<NextResponse> {
  try {
    // Verificar autenticación del coach
    const coachPayload = requireCoachAuth(request);

    await connectMongoose();

    const body = (await request.json()) as CreateRoomRequestBody;

    if (!body.clientId || !body.scheduledAt) {
      return NextResponse.json(
        { success: false, message: 'clientId y scheduledAt son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    if (!body.clientName || !body.clientEmail) {
      return NextResponse.json(
        { success: false, message: 'clientName y clientEmail son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Validar fecha
    const scheduledDate = new Date(body.scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      return NextResponse.json(
        { success: false, message: 'Fecha inválida', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    if (scheduledDate < new Date()) {
      return NextResponse.json(
        { success: false, message: 'La fecha debe ser futura', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Verificar que no haya un pending activo para este cliente
    const existingPending = await PendingSession.findOne({
      clientId: body.clientId,
      status: 'awaiting_payment',
      expiresAt: { $gt: new Date() },
    });

    if (existingPending) {
      return NextResponse.json(
        {
          success: false,
          message: 'Ya hay una solicitud de sesión pendiente de pago para este cliente',
          pendingSessionId: existingPending._id.toString(),
          code: 'CONFLICT',
        },
        { status: 409 }
      );
    }

    // Crear PendingSession (en lugar de crear la sala directamente)
    const pending = await PendingSession.create({
      clientId: body.clientId,
      clientName: body.clientName,
      clientEmail: body.clientEmail,
      coachId: coachPayload?.coachId || '',
      proposedDate: scheduledDate,
      duration: body.durationMinutes ?? 60,
      coachNotes: body.coachNotes ? encrypt(body.coachNotes) : '',
      timezone: body.timezone || '',
      status: 'awaiting_payment',
      requestedBy: 'coach',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h para pagar
    });

    // Obtener datos del coach para el email
    let coachName = 'Tu asesor';
    let coachEmail: string | undefined;
    try {
      const { default: Coach } = await import('@/app/models/Coach');
      const { decrypt } = await import('@/app/lib/encryption');
      const coachDoc = await Coach.findById(coachPayload.coachId).lean() as Record<string, unknown> | null;
      if (coachDoc?.firstName) {
        coachName = decrypt(coachDoc.firstName as string);
      }
      if (coachDoc?.email) {
        const decryptedEmail = decrypt(coachDoc.email as string);
        if (decryptedEmail && decryptedEmail.includes('@')) {
          coachEmail = decryptedEmail;
        }
      }
    } catch {
      // fallback al nombre genérico
    }

    // Enviar email al cliente con botón "Proceder al pago"
    try {
      const emailService = EmailService.getInstance();
      const formUrl = process.env.FORM_URL || 'http://localhost:3002';

      const paymentLink = `${formUrl}/request-session?pendingSessionId=${pending._id}`;

      const htmlContent = generatePaymentRequestEmailHTML({
        coachName,
        clientName: body.clientName,
        scheduledDate,
        scheduledTime: scheduledDate.toLocaleTimeString('es-MX', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        durationMinutes: body.durationMinutes ?? 60,
        paymentLink,
        coachEmail,
      });

      await emailService.sendEmail({
        to: [body.clientEmail],
        subject: '📹 Tu asesor ha solicitado una videollamada — NELHealthCoach',
        htmlBody: htmlContent,
      });
    } catch (emailError) {
      logger.error('VIDEO', 'Error enviando email de solicitud de pago', emailError as Error);
    }

    // Notificación in-app para el coach
    try {
      await createNotification({
        coachId: coachPayload.coachId,
        type: 'session_scheduled',
        title: '📹 Sesión de videollamada agendada',
        message: `Has agendado una sesión con ${body.clientName} para el ${scheduledDate.toLocaleDateString('es-MX')}. Pendiente de pago.`,
        link: `/dashboard/clients/${body.clientId}`,
      });
    } catch (notifError) {
      logger.error('NOTIFICATIONS', 'Error creando notificación de sesión', notifError as Error);
    }

    logger.info('VIDEO', 'Pending session created (awaiting payment)', {
      clientId: body.clientId,
      pendingId: pending._id.toString(),
      proposedDate: body.scheduledAt,
      duration: body.durationMinutes ?? 60,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          pendingSessionId: pending._id.toString(),
          status: 'awaiting_payment',
          proposedDate: body.scheduledAt,
          duration: body.durationMinutes ?? 60,
          message: 'Solicitud de sesión creada. Se ha enviado un email al cliente para realizar el pago.',
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';

    if (errorMessage.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    logger.error('VIDEO', 'Failed to create pending session', error as Error);

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

/**
 * GET /api/video/rooms?clientId=xxx
 *
 * Lista las sesiones pendientes de pago para un cliente.
 * Útil para que el coach vea el estado.
 */
async function getHandler(request: NextRequest): Promise<NextResponse> {
  try {
    requireCoachAuth(request);

    await connectMongoose();

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('clientId');
    const status = searchParams.get('status');

    const filter: Record<string, unknown> = {};
    if (clientId) filter.clientId = clientId;
    if (status) filter.status = status;

    const pendings = await PendingSession.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: pendings,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
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

export const GET = apiHandler(getHandler);
