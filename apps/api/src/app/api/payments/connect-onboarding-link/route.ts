// apps/api/src/app/api/payments/connect-onboarding-link/route.ts
// Genera un nuevo onboarding link (útil si el coach abandonó el proceso)

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { generateOnboardingLink } from '@/app/lib/stripe-connect';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/payments/connect-onboarding-link
 *
 * Genera un nuevo Account Link para que el coach complete su onboarding
 * en Stripe. Requiere que ya tenga una cuenta Connect creada.
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

    if (!coach.stripeConnectAccountId) {
      return NextResponse.json(
        { success: false, message: 'Primero debes crear una cuenta de Stripe', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const refreshUrl = `${appUrl}/dashboard/profile?stripe=canceled`;
    const returnUrl = `${appUrl}/dashboard/profile?stripe=success`;

    const link = await generateOnboardingLink(
      coach.stripeConnectAccountId,
      refreshUrl,
      returnUrl
    );

    logger.info('STRIPE_CONNECT', 'Nuevo onboarding link generado', {
      coachId: auth.coachId,
      accountId: coach.stripeConnectAccountId,
    });

    return NextResponse.json({
      success: true,
      url: link.url,
    });
  } catch (error: unknown) {
    logger.error('STRIPE_CONNECT', 'Error generando onboarding link', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al generar enlace de configuración',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
