import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import Coach, { hashEmail, emailHashVariants } from '@/app/models/Coach';
import { generateToken } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { EmailService } from '@/app/lib/email-service';
import { encrypt } from '@/app/lib/encryption';
import { hashToken } from '@/app/lib/tokenHash';
import { connectMongoose } from '@/app/lib/database';
import { registerSchema } from '@/app/lib/schemas';
import { secureRoute, requireServiceAvailable } from '@/app/lib/security/routeGuard';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';
import {
  generateVerificationEmailHTML,
} from '@/app/lib/email-templates';

function encryptPhoto(photo: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!photo) return null;
  return {
    url: encrypt(String(photo.url || '')),
    key: encrypt(String(photo.key || '')),
    name: encrypt(String(photo.name || '')),
    type: encrypt(String(photo.type || '')),
    size: photo.size as number,
    uploadedAt: String(photo.uploadedAt || ''),
  };
}

async function registerHandler(request: NextRequest) {
  // SEC-13: si MongoDB no está disponible, responder 503 (servicio caído)
  // con el mensaje uniforme que el frontend detecta para el toast de warning.
  const serviceCheck = await requireServiceAvailable();
  if (serviceCheck) return serviceCheck;

  const body = await request.json();

  // Rate limiting + brute force protection
  const rateResult = await secureRoute(request, body);
  if (!rateResult.passed) {
    logAuditEvent({
      eventType: 'RATE_LIMIT_HIT',
      severity: 'warning',
      message: `Rate limit en registro para IP ${request.headers.get('x-forwarded-for') || 'unknown'}`,
      ip: request.headers.get('x-forwarded-for') || undefined,
      path: '/api/auth/register',
      method: 'POST',
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
    });
    return NextResponse.json(
      { success: false, message: rateResult.message || 'Demasiados intentos. Intenta más tarde.' },
      // Usar el statusCode real del rate limiter: 429 (rate limit normal) o
      // 503 (fail-closed SEC-13: MongoDB no disponible) para que el frontend
      // pueda distinguir y avisar al usuario con un toast.
      { status: rateResult.statusCode || 429 },
    );
  }

  const { firstName, lastName, email, phone, password, professionalTitle, specialties, yearsOfExperience, bio, timezone } = body;

  // Zod validation
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
    professionalTitle: validProfessionalTitle,
    specialties: validSpecialties,
    yearsOfExperience: validYearsOfExperience,
    bio: validBio,
    timezone: validTimezone,
  } = parsed.data;

  const emailLower = validEmail.toLowerCase().trim();
  const emailHash = hashEmail(emailLower);

  // Extraer request context para audit logs
  const reqCtx = {
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    requestId: request.headers.get('x-request-id') || undefined,
  };

  // Verificar si ya existe por hash (dual: v2 HMAC + legacy sha256 pre-SEC-10)
  const existingCoach = await Coach.findOne({ emailHash: { $in: emailHashVariants(emailLower) } });
  if (existingCoach) {
    logAuditEvent({
      eventType: 'REGISTER_FAILURE',
      severity: 'warning',
      message: `Registro duplicado: ${emailLower}`,
      actorEmail: emailLower,
      ...reqCtx,
      path: '/api/auth/register',
      method: 'POST',
      statusCode: 409,
      metadata: { reason: 'email_exists' },
    });

    return NextResponse.json(
      { success: false, message: 'Ya existe una cuenta con este email', code: 'CONFLICT'},
      { status: 409 },
    );
  }

  // Protección: solo puede existir un admin (el creado por init-admin)
  const salt = await bcrypt.genSalt(10);

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
      path: '/api/auth/register',
      method: 'POST',
      statusCode: 403,
      metadata: { reason: 'admin_impersonation' },
    });

    return NextResponse.json(
      { success: false, message: 'No puedes registrarte con el email del administrador', code: 'FORBIDDEN'},
      { status: 403 },
    );
  }

  const passwordHash = await bcrypt.hash(validPassword, salt);
  // SEC-15: guardar solo el hash del token de verificación en DB
  const verificationToken = crypto.randomBytes(32).toString('hex');

  const coach = await Coach.create({
    email: encrypt(emailLower),
    emailHash,
    passwordHash,
    firstName: encrypt(validFirstName.trim()),
    lastName: encrypt(validLastName.trim()),
    phone: validPhone ? encrypt(validPhone) : '',
    professionalTitle: validProfessionalTitle ? encrypt(validProfessionalTitle.trim()) : '',
    specialties: validSpecialties && validSpecialties.length > 0 ? validSpecialties : [],
    yearsOfExperience: validYearsOfExperience || 0,
    bio: validBio ? encrypt(validBio.trim()) : '',
    timezone: validTimezone || '',
    role: 'coach',
    emailVerified: false,
    verificationToken: hashToken(verificationToken),
    isActive: true,
  });

  logAuditEvent({
    eventType: 'REGISTER_SUCCESS',
    severity: 'info',
    message: `Nuevo coach registrado: ${emailLower}`,
    actorEmail: emailLower,
    coachId: coach._id.toString(),
    actorRole: 'coach',
    ...reqCtx,
    path: '/api/auth/register',
    method: 'POST',
    statusCode: 201,
  });

  logger.info('AUTH', 'Nuevo coach registrado', {
    coachId: coach._id.toString(),
  });

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

  return NextResponse.json(
    {
      success: true,
      message: 'Cuenta creada exitosamente. Revisa tu email para verificar tu cuenta.',
    },
    { status: 201 },
  );
}

export const POST = apiHandler(registerHandler);
