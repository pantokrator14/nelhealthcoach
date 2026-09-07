// apps/api/src/app/api/payments/connect-account-status/route.ts
// Obtiene el estado de la cuenta Connect del coach

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { retrieveAccountStatus } from '@/app/lib/stripe-connect';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * GET /api/payments/connect-account-status
 *
 * Devuelve el estado actual de la cuenta Connect del coach.
 * Incluye si completó onboarding, si tiene pagos habilitados y su precio.
 */
async function getHandler(request: NextRequest) {
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
    const coach = await Coach.findById(auth.coachId).select('stripeConnectAccountId stripeOnboardingComplete stripePayoutsEnabled sessionPrice');

    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Si no tiene cuenta Connect
    if (!coach.stripeConnectAccountId) {
      return NextResponse.json({
        success: true,
        data: {
          hasAccount: false,
          onboardingComplete: false,
          payoutsEnabled: false,
          sessionPrice: coach.sessionPrice || 15000,
        },
      });
    }

    // Consultar estado en Stripe
    let onboardingComplete = coach.stripeOnboardingComplete || false;
    let payoutsEnabled = coach.stripePayoutsEnabled || false;

    if (!onboardingComplete || !payoutsEnabled) {
      try {
        const status = await retrieveAccountStatus(coach.stripeConnectAccountId);
        onboardingComplete = status.detailsSubmitted;
        payoutsEnabled = status.payoutsEnabled;

        // Actualizar en BD si cambió
        if (coach.stripeOnboardingComplete !== onboardingComplete || coach.stripePayoutsEnabled !== payoutsEnabled) {
          coach.stripeOnboardingComplete = onboardingComplete;
          coach.stripePayoutsEnabled = payoutsEnabled;
          await coach.save();
        }
      } catch (stripeError) {
        logger.warn('STRIPE_CONNECT', 'Error consultando estado en Stripe, usando cache', {
          coachId: auth.coachId,
          error: stripeError,
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        hasAccount: true,
        accountId: coach.stripeConnectAccountId,
        onboardingComplete,
        payoutsEnabled,
        sessionPrice: coach.sessionPrice || 15000,
      },
    });
  } catch (error: unknown) {
    logger.error('STRIPE_CONNECT', 'Error obteniendo estado de cuenta Connect', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al obtener estado de la cuenta',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);
