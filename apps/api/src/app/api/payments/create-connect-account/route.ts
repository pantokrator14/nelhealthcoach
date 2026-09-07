// apps/api/src/app/api/payments/create-connect-account/route.ts
// Crea una cuenta Connect Express para que el coach reciba pagos

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { decrypt } from '@/app/lib/encryption';
import { createConnectAccount, generateOnboardingLink } from '@/app/lib/stripe-connect';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/payments/create-connect-account
 *
 * Crea una cuenta Connect Express de Stripe para el coach autenticado
 * y devuelve la URL de onboarding para que complete sus datos bancarios.
 */
async function postHandler(request: NextRequest) {
  try {
    let auth;
    try {
      auth = requireCoachAuth(request);
    } catch {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }
    await connectMongoose();

    const { default: Coach } = await import('@/app/models/Coach');
    const coach = await Coach.findById(auth.coachId);

    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Si ya tiene una cuenta Connect, solo generar nuevo onboarding link
    if (coach.stripeConnectAccountId) {
      const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
      const refreshUrl = `${appUrl}/dashboard/profile?stripe=canceled`;
      const returnUrl = `${appUrl}/dashboard/profile?stripe=success`;

      const link = await generateOnboardingLink(
        coach.stripeConnectAccountId,
        refreshUrl,
        returnUrl
      );

      return NextResponse.json({
        success: true,
        url: link.url,
        accountId: coach.stripeConnectAccountId,
        isNew: false,
      });
    }

    // Desencriptar datos personales
    const email = decrypt(coach.email);
    const firstName = decrypt(coach.firstName);
    const lastName = decrypt(coach.lastName);

    // Crear cuenta Connect Express
    const account = await createConnectAccount(
      auth.coachId,
      email,
      firstName,
      lastName
    );

    // Guardar el ID en el coach
    coach.stripeConnectAccountId = account.id;
    await coach.save();

    logger.info('STRIPE_CONNECT', 'Cuenta Connect guardada en coach', {
      coachId: auth.coachId,
      accountId: account.id,
    });

    // Generar onboarding link
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const refreshUrl = `${appUrl}/dashboard/profile?stripe=canceled`;
    const returnUrl = `${appUrl}/dashboard/profile?stripe=success`;

    const link = await generateOnboardingLink(
      account.id,
      refreshUrl,
      returnUrl
    );

    return NextResponse.json({
      success: true,
      url: link.url,
      accountId: account.id,
      isNew: true,
    });
  } catch (error: unknown) {
    logger.error('STRIPE_CONNECT', 'Error creando cuenta Connect', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al conectar con Stripe. Intenta de nuevo.',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
