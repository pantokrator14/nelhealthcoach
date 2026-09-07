// apps/api/src/app/api/payments/portal/route.ts
// Crea un Customer Portal de Stripe para que el coach gestione su suscripción

import { NextRequest, NextResponse } from 'next/server';
import { stripeClient } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { decrypt } from '@/app/lib/encryption';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/payments/portal
 *
 * Crea una sesión del Customer Portal de Stripe para que el coach
 * pueda gestionar su suscripción, método de pago, facturas, etc.
 *
 * Requiere autenticación de coach.
 */
async function postHandler(request: NextRequest) {
  try {
    // Verificar autenticación
    const authResult = requireCoachAuth(request);
    if (!authResult) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    await connectMongoose();

    const { default: Coach } = await import('@/app/models/Coach');
    const coach = await Coach.findById(authResult.coachId);

    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Desencriptar stripeCustomerId
    let stripeCustomerId: string | null = null;
    if (coach.stripeCustomerId) {
      try {
        stripeCustomerId = decrypt(coach.stripeCustomerId);
      } catch {
        logger.error('PAYMENTS', 'Error desencriptando stripeCustomerId', {
          coachId: coach._id.toString(),
        });
      }
    }

    if (!stripeCustomerId) {
      return NextResponse.json(
        { success: false, message: 'No tienes una suscripción activa de Stripe', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Obtener la URL base
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

    // Crear sesión del portal
    const portalSession = await stripeClient.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${appUrl}/dashboard/profile`,
    });

    logger.info('PAYMENTS', 'Portal de facturación creado', {
      coachId: authResult.coachId,
      stripeCustomerId,
    });

    return NextResponse.json(
      {
        success: true,
        url: portalSession.url,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('PAYMENTS', 'Error creando portal de facturación', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al abrir el portal de facturación',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
