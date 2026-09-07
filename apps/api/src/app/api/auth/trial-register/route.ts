// apps/api/src/app/api/auth/trial-register/route.ts
// Registro de coach con prueba gratuita de 30 días + verificación de tarjeta por $1
// Usa Stripe Checkout Session (mismo patrón que create-coach-checkout)

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import Coach, { hashEmail, emailHashVariants } from '@/app/models/Coach';
import TrialRecord from '@/app/models/TrialRecord';
import { generateToken } from '@/app/lib/auth';
import { createTrialCheckoutSession } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { encrypt } from '@/app/lib/encryption';
import { hashToken } from '@/app/lib/tokenHash';
import { requireServiceAvailable } from '@/app/lib/security/routeGuard';
import { registerSchema } from '@/app/lib/schemas';

import { uploadBufferToS3 } from '@/app/lib/s3';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';

const TRIAL_DAYS = 30;

/**
 * POST /api/auth/trial-register
 *
 * Body: { firstName, lastName, email, phone, password }
 *
 * 1. Crea el coach con trialStatus='active' (isActive=false hasta verificar tarjeta)
 * 2. Crea un Checkout Session de $1 para verificar tarjeta
 * 3. Devuelve la URL de Stripe para redirigir al coach
 * 4. El webhook confirma el pago, reembolsa y activa la cuenta
 */
async function postHandler(request: NextRequest) {
  try {
    // SEC-13: si MongoDB no está disponible, responder 503 (servicio caído)
    // con el mensaje uniforme que el frontend detecta para el toast de warning.
    const serviceCheck = await requireServiceAvailable();
    if (serviceCheck) return serviceCheck;

    const body = await request.json();

    // Request context para audit logs
    const reqCtx = {
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
    };

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

    // profilePhoto no está en el schema (es dato opcional base64)
    const { profilePhoto } = body as { profilePhoto?: string };
    // Evidencia de aceptación del acuerdo de asesor (v1.0+): opcional por compatibilidad
    const { contractAccepted, contractVersion } = body as {
      contractAccepted?: boolean;
      contractVersion?: string;
    };

    const emailLower = validEmail.toLowerCase().trim();
    const emailHash = hashEmail(emailLower);

    // Verificar si ya existe como coach (dual: v2 HMAC + legacy sha256 pre-SEC-10)
    const existingCoach = await Coach.findOne({ emailHash: { $in: emailHashVariants(emailLower) } });
    if (existingCoach) {
      logAuditEvent({
        eventType: 'REGISTER_FAILURE',
        severity: 'warning',
        message: `Trial register duplicado: ${emailLower}`,
        actorEmail: emailLower,
        ...reqCtx,
        path: '/api/auth/trial-register',
        method: 'POST',
        statusCode: 409,
        metadata: { reason: 'email_exists' },
      });
      return NextResponse.json(
        { success: false, message: 'Ya existe una cuenta con este email', code: 'CONFLICT'},
        { status: 409 }
      );
    }

    // Verificar si ya usó trial anteriormente (persiste aunque la cuenta se haya borrado)
    const existingTrial = await TrialRecord.findOne({ emailHash: { $in: emailHashVariants(emailLower) } });
    if (existingTrial) {
      logAuditEvent({
        eventType: 'REGISTER_FAILURE',
        severity: 'warning',
        message: `Trial register: email ya usó prueba gratuita: ${emailLower}`,
        actorEmail: emailLower,
        ...reqCtx,
        path: '/api/auth/trial-register',
        method: 'POST',
        statusCode: 409,
        metadata: { reason: 'trial_already_used' },
      });
      return NextResponse.json(
        {
          success: false,
          code: 'TRIAL_ALREADY_USED',
          message: 'Este email ya usó el período de prueba. Regístrate al plan de pago.',
        },
        { status: 409 }
      );
    }

    // Protección: admin no puede suplantarse
    const adminEmailHash = process.env.ADMIN_EMAIL
      ? hashEmail(process.env.ADMIN_EMAIL.toLowerCase().trim())
      : null;

    if (adminEmailHash && emailHash === adminEmailHash) {
      logAuditEvent({
        eventType: 'REGISTER_FAILURE',
        severity: 'error',
        message: `Intento de suplantación del admin (trial): ${emailLower}`,
        actorEmail: emailLower,
        ...reqCtx,
        path: '/api/auth/trial-register',
        method: 'POST',
        statusCode: 403,
        metadata: { reason: 'admin_impersonation' },
      });
      return NextResponse.json(
        { success: false, message: 'No puedes registrarte con el email del administrador', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    // Crear fechas del trial
    const now = new Date();
    const trialEndDate = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    // Hash de password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(validPassword, salt);
    // SEC-15: guardar solo el hash del token de verificación en DB
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Crear coach (inactivo hasta verificar tarjeta via Stripe Checkout)
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
      isActive: false,
      subscriptionStatus: 'incomplete',
      trialStatus: 'active',
      trialStartDate: now,
      trialEndDate: trialEndDate,
      // Evidencia de aceptación del acuerdo de asesor (solo si el front lo envió)
      ...(contractAccepted === true && {
        contractAccepted: true,
        contractVersion: contractVersion || '1.0',
        contractAcceptedAt: now,
      }),
    });

    // Subir foto de perfil si se proporcionó (base64)
    if (profilePhoto && typeof profilePhoto === 'string' && profilePhoto.startsWith('data:image/')) {
      try {
        const matches = profilePhoto.match(/^data:(image\/\w+);base64,(.+)$/);
        if (matches) {
          const mimeType = matches[1];
          const ext = mimeType.split('/')[1] || 'jpg';
          const buffer = Buffer.from(matches[2], 'base64');
          const { url, key } = await uploadBufferToS3(buffer, `profile.${ext}`, mimeType, 'profile');
          await Coach.findByIdAndUpdate(coach._id, {
            $set: {
              profilePhoto: {
                url: encrypt(url),
                key: encrypt(key),
                name: encrypt('profile.' + ext),
                type: encrypt(mimeType),
                size: buffer.length,
                uploadedAt: new Date().toISOString(),
              },
            },
          });
        }
      } catch (uploadError) {
        logger.error('AUTH', 'Error subiendo foto de perfil en trial-register', uploadError as Error);
        // No bloquear el registro si la foto falla
      }
    }

    logger.info('AUTH', 'Nuevo coach registrado en trial', {
      coachId: coach._id.toString(),
      trialEndDate: trialEndDate.toISOString(),
    });

    // Crear Checkout Session de $1
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

    let checkoutUrl = '';
    try {
      const session = await createTrialCheckoutSession(
        emailLower,
        `${appUrl}/dashboard/trial/verify-card?coachId=${coach._id.toString()}&session_id={CHECKOUT_SESSION_ID}`,
        `${appUrl}/register?canceled=true`
      );
      checkoutUrl = String((session as Record<string, unknown>).url || '');
      if (!checkoutUrl) {
        logger.warn('AUTH', 'Stripe no devolvió URL de checkout — trial procede sin verificación de tarjeta');
      }
    } catch (stripeError) {
      // No fatal: el coach ya fue creado, el trial procede sin verificación de tarjeta
      logger.warn('AUTH', 'No se pudo crear Checkout Session de trial — el registro continúa sin verificación', stripeError as Error);
    }

    // Registrar el trial en TrialRecord
    try {
      await TrialRecord.create({ emailHash });
    } catch (trialRecordError) {
      logger.error('AUTH', 'Error creando TrialRecord', trialRecordError as Error);
    }

    // Audit log
    logAuditEvent({
      eventType: 'REGISTER_SUCCESS',
      severity: 'info',
      message: `Nuevo coach registrado en trial: ${emailLower}`,
      actorEmail: emailLower,
      coachId: coach._id.toString(),
      actorRole: 'coach',
      ...reqCtx,
      path: '/api/auth/trial-register',
      method: 'POST',
      statusCode: 201,
      metadata: { trialEndDate: trialEndDate.toISOString(), trialDays: TRIAL_DAYS },
    });

    return NextResponse.json(
      {
        success: true,
        message: checkoutUrl
          ? 'Cuenta creada exitosamente. Verifica tu tarjeta para activar tu prueba gratuita.'
          : 'Cuenta creada exitosamente. Tu prueba gratuita está activa.',
        data: {
          checkoutUrl,
          coachId: coach._id.toString(),
          trialEndDate: trialEndDate.toISOString(),
          isTrial: true,
          cardVerificationSkipped: !checkoutUrl,
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    logger.error('AUTH', 'Error en trial-register', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
