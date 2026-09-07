import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import Coach from '@/app/models/Coach';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { encrypt, decrypt } from '@/app/lib/encryption';
import { connectMongoose } from '@/app/lib/database';
import { apiHandler } from '@/app/lib/apiHandler';

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

function decryptPhoto(photo: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!photo || !photo.url) return null;
  const urlRaw = String(photo.url);
  const keyRaw = String(photo.key || '');
  const nameRaw = String(photo.name || '');
  const typeRaw = String(photo.type || '');
  return {
    url: decrypt(urlRaw),
    key: keyRaw ? decrypt(keyRaw) : keyRaw,
    name: nameRaw ? decrypt(nameRaw) : nameRaw,
    type: typeRaw ? decrypt(typeRaw) : typeRaw,
    size: Number(photo.size) || 0,
    uploadedAt: String(photo.uploadedAt || ''),
  };
}

async function getHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);
    const coach = await Coach.findById(auth.coachId).select('-passwordHash -verificationToken -resetToken -resetTokenExpiry');

    if (!coach) {
      return NextResponse.json({ success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'}, { status: 404 });
    }

    // Determinar estado de Stripe Connect
    const stripeConnectStatus = coach.stripeConnectAccountId
      ? {
          hasAccount: true,
          onboardingComplete: coach.stripeOnboardingComplete || false,
          payoutsEnabled: coach.stripePayoutsEnabled || false,
          sessionPrice: coach.sessionPrice || 15000,
        }
      : {
          hasAccount: false,
          onboardingComplete: false,
          payoutsEnabled: false,
          sessionPrice: coach.sessionPrice || 15000,
        };

    // Calcular días restantes de trial
    let trialDaysRemaining = 0;
    let trialIsActive = false;
    if (coach.trialStatus === 'active' && coach.trialEndDate) {
      const now = new Date();
      trialIsActive = now < coach.trialEndDate;
      trialDaysRemaining = trialIsActive
        ? Math.ceil((coach.trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : 0;
    }

    return NextResponse.json({
      success: true,
      data: {
        id: coach._id.toString(),
        email: decrypt(coach.email),
        firstName: decrypt(coach.firstName),
        lastName: decrypt(coach.lastName),
        phone: coach.phone ? decrypt(coach.phone) : '',
        professionalTitle: coach.professionalTitle ? decrypt(coach.professionalTitle) : '',
        specialties: coach.specialties || [],
        yearsOfExperience: coach.yearsOfExperience || 0,
        bio: coach.bio ? decrypt(coach.bio) : '',
        timezone: coach.timezone || '',
        profilePhoto: decryptPhoto(coach.profilePhoto as unknown as Record<string, unknown> | null),
        role: coach.role,
        emailVerified: coach.emailVerified,
        isSuspended: coach.isSuspended || false,
        isActive: coach.isActive !== false,
        trialStatus: coach.trialStatus || 'none',
        subscriptionStatus: coach.subscriptionStatus,
        trialEndDate: coach.trialEndDate?.toISOString(),
        hasStripeCustomer: !!coach.stripeCustomerId,
        daysRemaining: trialDaysRemaining,
        subscriptionLabel: getSubscriptionLabel(coach, trialDaysRemaining, trialIsActive),
        stripeConnect: stripeConnectStatus,
        trial: {
          status: coach.trialStatus || 'none',
          startDate: coach.trialStartDate,
          endDate: coach.trialEndDate,
          daysRemaining: trialDaysRemaining,
          isActive: trialIsActive,
        },
      },
    });
  } catch (error: unknown) {
    // SEC: requireCoachAuth lanza error estructurado { status: 401 }
    const structured = error as { status?: number; message?: string };
    if (structured?.status === 401 || (error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('AUTH', 'Error obteniendo perfil', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'}, 
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);

async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);
    const body = await request.json();
    const { action } = body;

    const coach = await Coach.findById(auth.coachId);
    if (!coach) {
      return NextResponse.json({ success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'}, { status: 404 });
    }

    switch (action) {
      case 'verify-password': {
        const { currentPassword } = body;
        if (!currentPassword) {
          return NextResponse.json({ success: false, message: 'Ingresa tu contraseña actual', code: 'VALIDATION'}, { status: 400 });
        }
        const isMatch = await bcrypt.compare(currentPassword, coach.passwordHash);
        if (!isMatch) {
          return NextResponse.json({ success: false, message: 'Contraseña incorrecta', code: 'INVALID_PASSWORD'}, { status: 401 });
        }
        return NextResponse.json({ success: true, message: 'Contraseña verificada' });
      }

      case 'suspend': {
        coach.isSuspended = true;
        await coach.save();
        logger.info('ACCOUNT', `Coach ${coach.email} suspendió su cuenta`);
        return NextResponse.json({ success: true, message: 'Cuenta suspendida exitosamente' });
      }

      case 'delete': {
        const { currentPassword } = body;
        if (!currentPassword) {
          return NextResponse.json({ success: false, message: 'Ingresa tu contraseña para confirmar', code: 'VALIDATION'}, { status: 400 });
        }
        const isMatch = await bcrypt.compare(currentPassword, coach.passwordHash);
        if (!isMatch) {
          return NextResponse.json({ success: false, message: 'Contraseña incorrecta', code: 'INVALID_PASSWORD'}, { status: 401 });
        }
        await Coach.findByIdAndDelete(auth.coachId);
        logger.info('ACCOUNT', `Coach eliminó su cuenta: ${coach.email}`);
        return NextResponse.json({ success: true, message: 'Cuenta eliminada exitosamente' });
      }

      default:
        return NextResponse.json({ success: false, message: `Acción desconocida: ${action}`, code: 'VALIDATION'}, { status: 400 });
    }
  } catch (error: unknown) {
    // SEC: requireCoachAuth lanza error estructurado { status: 401 } — reconocer
    // ambos patrones (estructurado y legacy con 'Token' en el mensaje)
    const structured = error as { status?: number; message?: string };
    if (structured?.status === 401 || (error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('ACCOUNT', 'Error en gestión de cuenta', error instanceof Error ? error : new Error(String(error)));
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

async function putHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);
    const body = await request.json();

    const coach = await Coach.findById(auth.coachId);
    if (!coach) {
      return NextResponse.json({ success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'}, { status: 404 });
    }

    if (body.firstName !== undefined) coach.firstName = encrypt(body.firstName.trim());
    if (body.lastName !== undefined) coach.lastName = encrypt(body.lastName.trim());
    if (body.phone !== undefined) coach.phone = encrypt(body.phone);
    if (body.professionalTitle !== undefined) coach.professionalTitle = encrypt(body.professionalTitle.trim());
    if (body.specialties !== undefined) coach.specialties = body.specialties;
    if (body.yearsOfExperience !== undefined) coach.yearsOfExperience = body.yearsOfExperience;
    if (body.bio !== undefined) coach.bio = encrypt(body.bio.trim());
    if (body.timezone !== undefined) coach.timezone = body.timezone;
    if (body.profilePhoto !== undefined) {
      coach.profilePhoto = encryptPhoto(body.profilePhoto) as unknown as typeof coach.profilePhoto;
    }

    await coach.save();

    // Calcular días restantes de trial
    let trialDaysRemaining = 0;
    let trialIsActive = false;
    if (coach.trialStatus === 'active' && coach.trialEndDate) {
      const now = new Date();
      trialIsActive = now < coach.trialEndDate;
      trialDaysRemaining = trialIsActive
        ? Math.ceil((coach.trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : 0;
    }

    return NextResponse.json({
      success: true,
      message: 'Perfil actualizado exitosamente',
      data: {
        id: coach._id.toString(),
        email: decrypt(coach.email),
        firstName: decrypt(coach.firstName),
        lastName: decrypt(coach.lastName),
        phone: coach.phone ? decrypt(coach.phone) : '',
        professionalTitle: coach.professionalTitle ? decrypt(coach.professionalTitle) : '',
        specialties: coach.specialties || [],
        yearsOfExperience: coach.yearsOfExperience || 0,
        bio: coach.bio ? decrypt(coach.bio) : '',
        timezone: coach.timezone || '',
        profilePhoto: decryptPhoto(coach.profilePhoto as unknown as Record<string, unknown> | null),
        role: coach.role,
        emailVerified: coach.emailVerified,
        isSuspended: coach.isSuspended || false,
        subscriptionStatus: coach.subscriptionStatus,
        daysRemaining: trialDaysRemaining,
        subscriptionLabel: getSubscriptionLabel(coach, trialDaysRemaining, trialIsActive),
        trial: {
          status: coach.trialStatus || 'none',
          startDate: coach.trialStartDate,
          endDate: coach.trialEndDate,
          daysRemaining: trialDaysRemaining,
          isActive: trialIsActive,
        },
      },
    });
  } catch (error: unknown) {
    // SEC: requireCoachAuth lanza error estructurado { status: 401 } — reconocer
    // ambos patrones (estructurado y legacy con 'Token' en el mensaje)
    const structured = error as { status?: number; message?: string };
    if (structured?.status === 401 || (error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('AUTH', 'Error actualizando perfil', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'}, 
      { status: 500 }
    );
  }
}

export const PUT = apiHandler(putHandler);

function getSubscriptionLabel(
  coach: { isSuspended?: boolean; trialStatus?: string; subscriptionStatus?: string },
  daysRemaining: number,
  trialIsActive: boolean
): string {
  if (coach.isSuspended) return 'Cuenta suspendida';
  if (coach.trialStatus === 'active' && trialIsActive) {
    return `Tienes ${daysRemaining} días restantes de prueba`;
  }
  if (coach.trialStatus === 'expired') return 'Prueba gratuita finalizada';
  if (coach.subscriptionStatus === 'active') return 'Suscripción activa';
  if (coach.subscriptionStatus === 'past_due') return 'Suscripción con pago atrasado';
  if (coach.subscriptionStatus === 'canceled') return 'Suscripción cancelada';
  return 'Sin suscripción activa';
}
