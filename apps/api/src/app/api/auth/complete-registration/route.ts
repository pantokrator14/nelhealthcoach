// apps/api/src/app/api/auth/complete-registration/route.ts
// Completa el registro del coach después del pago exitoso

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import Coach, { hashEmail, emailHashVariants } from '@/app/models/Coach';
import PendingCoach from '@/app/models/PendingCoach';
import { generateToken } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { EmailService } from '@/app/lib/email-service';
import { encrypt } from '@/app/lib/encryption';
import { hashToken } from '@/app/lib/tokenHash';
import { requireServiceAvailable } from '@/app/lib/security/routeGuard';
import { registerSchema } from '@/app/lib/schemas';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';
import { generateVerificationEmailHTML, generateWelcomeCoachEmailHTML } from '@/app/lib/email-templates';
import { uploadBufferToS3 } from '@/app/lib/s3';

async function completeRegistrationHandler(request: NextRequest) {
  // SEC-13: si MongoDB no está disponible, responder 503 (servicio caído)
  // con el mensaje uniforme que el frontend detecta para el toast de warning.
  const serviceCheck = await requireServiceAvailable();
  if (serviceCheck) return serviceCheck;

  const body = await request.json();
  const { token, firstName, lastName, email, phone, password, profilePhoto } = body as {
    token?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    password?: string;
    profilePhoto?: string;
  };

  const reqCtx = {
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    requestId: request.headers.get('x-request-id') || undefined,
  };

  if (!token || typeof token !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Token de registro requerido', code: 'VALIDATION'},
      { status: 400 },
    );
  }

  // Validar con Zod
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json(
      { success: false, message: firstError?.message ?? 'Datos de registro inválidos', code: 'VALIDATION'},
      { status: 400 },
    );
  }

  const {
    firstName: validFirstName,
    lastName: validLastName,
    email: validEmail,
    phone: validPhone,
    password: validPassword,
  } = parsed.data;

  // Buscar el pending coach
  // SEC-15: buscar por hash del token (con fallback legacy para tokens planos)
  let pending = await PendingCoach.findOne({ token: hashToken(token) });
  if (!pending) {
    pending = await PendingCoach.findOne({ token });
  }

  if (!pending) {
    logAuditEvent({
      eventType: 'REGISTER_FAILURE',
      severity: 'warning',
      message: `Complete-registration: token inválido o expirado`,
      ...reqCtx,
      path: '/api/auth/complete-registration',
      method: 'POST',
      statusCode: 404,
      metadata: { submittedEmail: validEmail?.toLowerCase().trim() },
    });

    return NextResponse.json(
      { success: false, message: 'Token inválido o expirado. Por favor, regístrate nuevamente.', code: 'NOT_FOUND'},
      { status: 404 },
    );
  }

  if (pending.paymentStatus !== 'completed') {
    return NextResponse.json(
      { success: false, message: 'El pago de la suscripción no ha sido completado', code: 'VALIDATION'},
      { status: 402 },
    );
  }

  if (pending.expiresAt < new Date()) {
    return NextResponse.json(
      { success: false, message: 'El tiempo para completar el registro ha expirado. Regístrate nuevamente.', code: 'VALIDATION'},
      { status: 410 },
    );
  }

  // Verificar que el email coincida con el del pending
  if (pending.email !== validEmail.toLowerCase().trim()) {
    return NextResponse.json(
      { success: false, message: 'El email debe coincidir con el usado en el pago', code: 'VALIDATION'},
      { status: 400 },
    );
  }

  // Verificar si ya existe
  const emailLower = validEmail.toLowerCase().trim();
  const emailHash = hashEmail(emailLower);

  // Búsqueda dual: v2 HMAC + legacy sha256 (cuentas pre-SEC-10)
  const existingCoach = await Coach.findOne({ emailHash: { $in: emailHashVariants(emailLower) } });
  if (existingCoach) {
    logAuditEvent({
      eventType: 'REGISTER_FAILURE',
      severity: 'warning',
      message: `Complete-registration: email duplicado ${emailLower}`,
      actorEmail: emailLower,
      ...reqCtx,
      path: '/api/auth/complete-registration',
      method: 'POST',
      statusCode: 409,
    });

    return NextResponse.json(
      { success: false, message: 'Ya existe una cuenta con este email', code: 'CONFLICT'},
      { status: 409 },
    );
  }

  // Subir foto de perfil si se proporcionó (base64)
  let profilePhotoData: Record<string, unknown> | undefined;
  if (profilePhoto && typeof profilePhoto === 'string' && profilePhoto.startsWith('data:image/')) {
    try {
      const matches = profilePhoto.match(/^data:(image\/\w+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const ext = mimeType.split('/')[1] || 'jpg';
        const buffer = Buffer.from(matches[2], 'base64');
        const { url, key } = await uploadBufferToS3(buffer, `profile.${ext}`, mimeType, 'profile');
        profilePhotoData = {
          url: encrypt(url),
          key: encrypt(key),
          name: encrypt('profile.' + ext),
          type: encrypt(mimeType),
          size: buffer.length,
          uploadedAt: new Date().toISOString(),
        };
      }
    } catch (uploadError) {
      logger.error('AUTH', 'Error subiendo foto de perfil', uploadError as Error);
    }
  }

  // Protección: admin no puede suplantarse
  const adminEmailHash = process.env.ADMIN_EMAIL
    ? hashEmail(process.env.ADMIN_EMAIL.toLowerCase().trim())
    : null;

  if (adminEmailHash && emailHash === adminEmailHash) {
    logAuditEvent({
      eventType: 'REGISTER_FAILURE',
      severity: 'error',
      message: `Intento de suplantación del admin: ${emailLower}`,
      actorEmail: emailLower,
      ...reqCtx,
      path: '/api/auth/complete-registration',
      method: 'POST',
      statusCode: 403,
    });

    return NextResponse.json(
      { success: false, message: 'No puedes registrarte con el email del administrador', code: 'FORBIDDEN'},
      { status: 403 },
    );
  }

  // Crear el coach
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(validPassword, salt);
  // SEC-15: guardar solo el hash del token de verificación en DB
  const verificationToken = crypto.randomBytes(32).toString('hex');

  const encryptedStripeCustomerId = pending.stripeCustomerId
    ? encrypt(pending.stripeCustomerId)
    : '';
  const encryptedSubscriptionId = pending.subscriptionId
    ? encrypt(pending.subscriptionId)
    : '';

  const coachData: Record<string, unknown> = {
    email: encrypt(emailLower),
    emailHash,
    passwordHash,
    firstName: encrypt(validFirstName.trim()),
    lastName: encrypt(validLastName.trim()),
    phone: validPhone ? encrypt(validPhone) : '',
    role: 'coach',
    emailVerified: false,
    verificationToken: hashToken(verificationToken),
    isActive: true,
    stripeCustomerId: encryptedStripeCustomerId,
    subscriptionId: encryptedSubscriptionId,
    subscriptionStatus: 'active',
  };

  if (profilePhotoData) {
    coachData.profilePhoto = profilePhotoData;
  }

  const coach = await Coach.create(coachData);

  // Eliminar el pending coach
  await PendingCoach.deleteOne({ _id: pending._id });

  logAuditEvent({
    eventType: 'REGISTER_SUCCESS',
    severity: 'info',
    message: `Nuevo coach registrado con suscripción Stripe: ${emailLower}`,
    actorEmail: emailLower,
    coachId: coach._id.toString(),
    actorRole: 'coach',
    ...reqCtx,
    path: '/api/auth/complete-registration',
    method: 'POST',
    statusCode: 201,
    metadata: { stripeCustomerId: pending.stripeCustomerId },
  });

  logger.info('AUTH', 'Nuevo coach registrado con suscripción Stripe', {
    coachId: coach._id.toString(),
    stripeCustomerId: pending.stripeCustomerId,
  });

  // Enviar email de verificación
  try {
    const emailService = EmailService.getInstance();
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const verifyUrl = `${appUrl}/verify-email?token=${verificationToken}`;

    await emailService.sendEmail({
      to: [emailLower],
      subject: 'Verifica tu cuenta - NELHEALTHCOACH',
      htmlBody: generateVerificationEmailHTML({
        coachName: validFirstName,
        verifyUrl,
      }),
    });
  } catch (emailError) {
    logger.error('AUTH', 'Error enviando email de verificación', emailError as Error);
  }

  // Enviar email de bienvenida
  try {
    const emailService = EmailService.getInstance();
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

    await emailService.sendEmail({
      to: [emailLower],
      subject: '🎉 Bienvenido a NELHEALTHCOACH — Tu cuenta ha sido creada',
      htmlBody: generateWelcomeCoachEmailHTML({
        coachName: validFirstName,
        loginUrl: `${dashboardUrl}/login`,
      }),
    });
  } catch (emailError) {
    logger.error('AUTH', 'Error enviando email de bienvenida', emailError as Error);
  }

  return NextResponse.json(
    {
      success: true,
      message: 'Cuenta creada exitosamente. Revisa tu email para verificar tu cuenta.',
    },
    { status: 201 },
  );
}

export const POST = apiHandler(completeRegistrationHandler);
