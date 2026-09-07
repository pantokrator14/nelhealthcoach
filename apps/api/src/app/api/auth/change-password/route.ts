import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import Coach from '@/app/models/Coach';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { EmailService } from '@/app/lib/email-service';
import { decrypt } from '@/app/lib/encryption';
import { changePasswordSchema } from '@/app/lib/schemas';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';
import { createNotification } from '@/app/lib/create-notification';

async function changePasswordHandler(request: NextRequest) {
  await connectMongoose();

  // SEC: requireCoachAuth lanza Error sin status → capturar y responder 401
  // (antes: apiHandler lo convertía en 500 genérico, revelando "Error interno")
  let auth;
  try {
    auth = requireCoachAuth(request);
  } catch (authError) {
    logAuditEvent({
      eventType: 'UNAUTHORIZED_ACCESS',
      severity: 'warning',
      message: `Cambio de contraseña sin token válido: ${(authError as Error).message}`,
      actorEmail: undefined,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
      path: '/api/auth/change-password',
      method: 'POST',
      statusCode: 401,
    });
    return NextResponse.json(
      { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
      { status: 401 },
    );
  }

  const body = await request.json();
  const { currentPassword, newPassword } = body;

  const reqCtx = {
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    requestId: request.headers.get('x-request-id') || undefined,
  };

  // Zod validation
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json(
      { success: false, message: firstError?.message ?? 'Datos de contraseña inválidos', code: 'VALIDATION'},
      { status: 400 },
    );
  }

  const { currentPassword: validCurrent, newPassword: validNew } = parsed.data;

  // Actualizar contraseña
  const coach = await Coach.findById(auth.coachId);
  if (!coach) {
    return NextResponse.json(
      { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
      { status: 404 },
    );
  }

  // Verificar contraseña actual
  const isMatch = await bcrypt.compare(validCurrent, coach.passwordHash);
  if (!isMatch) {
    logAuditEvent({
      eventType: 'PASSWORD_CHANGE_FAILURE',
      severity: 'warning',
      message: `Cambio de contraseña falló — contraseña actual incorrecta`,
      coachId: coach._id.toString(),
      actorEmail: auth.email,
      ...reqCtx,
      path: '/api/auth/change-password',
      method: 'POST',
      statusCode: 400,
    });

    return NextResponse.json(
      { success: false, message: 'La contraseña actual es incorrecta', code: 'VALIDATION'},
      { status: 400 },
    );
  }

  // Actualizar contraseña
  const salt = await bcrypt.genSalt(10);
  coach.passwordHash = await bcrypt.hash(validNew, salt);
  await coach.save();

  // Audit log del cambio exitoso
  logAuditEvent({
    eventType: 'PASSWORD_CHANGE_SUCCESS',
    severity: 'info',
    message: `Contraseña actualizada exitosamente`,
    coachId: coach._id.toString(),
    actorEmail: auth.email,
    actorRole: auth.role,
    ...reqCtx,
    path: '/api/auth/change-password',
    method: 'POST',
    statusCode: 200,
  });

  // Enviar notificación por email al coach
  const emailService = EmailService.getInstance();
  const coachName = decrypt(coach.firstName) || 'Coach';
  await emailService.sendEmail({
    to: [auth.email],
    subject: 'NELHealthCoach - Tu contraseña ha sido cambiada',
    htmlBody: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #059669, #047857); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Contraseña actualizada</h1>
        </div>
        <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="font-size: 16px; color: #374151;">Hola <strong>${coachName}</strong>,</p>
          <p style="font-size: 16px; color: #374151;">Tu contraseña de <strong>NELHealthCoach</strong> ha sido cambiada exitosamente.</p>
          <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #92400e;">
              ⚠️ Si no fuiste tú quien realizó este cambio, contacta al administrador inmediatamente.
            </p>
          </div>
          <p style="font-size: 14px; color: #6b7280; margin-top: 24px;">Este es un mensaje automático, por favor no respondas a este correo.</p>
        </div>
      </div>
    `,
  }).catch((err) => {
    logger.warn('AUTH', 'Error enviando notificación de cambio de contraseña', err);
  });

  logger.info('AUTH', 'Contraseña actualizada', {
    coachId: coach._id.toString(),
  });

  // Notificación in-app
  try {
    await createNotification({
      coachId: coach._id.toString(),
      type: 'password_changed',
      title: '🔑 Contraseña cambiada',
      message: 'Tu contraseña de NELHEALTHCOACH ha sido actualizada exitosamente.',
      link: '/dashboard/profile',
    });
  } catch (notifError) {
    logger.warn('AUTH', 'Error creando notificación de cambio de contraseña', notifError as Error);
  }

  return NextResponse.json({
    success: true,
    message: 'Contraseña actualizada exitosamente',
  });
}

export const POST = apiHandler(changePasswordHandler);
