// apps/api/src/app/api/payments/create-coach-checkout/route.ts
// Crea un Checkout Session de Stripe para la suscripción del coach

import { NextRequest, NextResponse } from 'next/server';
import { stripeClient, getCoachSubscriptionAmount } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { hashToken } from '@/app/lib/tokenHash';
import { apiHandler } from '@/app/lib/apiHandler';
import crypto from 'crypto';

/**
 * POST /api/payments/create-coach-checkout
 *
 * Body: { email, contractAccepted }
 *
 * 1. Crea un PendingCoach en MongoDB
 * 2. Crea un Checkout Session de Stripe (subscription)
 * 3. Devuelve la URL de Stripe para redirigir al coach
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();

    const body = await request.json();
    const { email, contractAccepted, contractVersion } = body as {
      email?: string;
      contractAccepted?: boolean;
      contractVersion?: string;
    };

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { success: false, message: 'El email es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    if (!contractAccepted) {
      return NextResponse.json(
        { success: false, message: 'Debes aceptar el contrato para continuar', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Crear un token único para este registro pendiente
    // SEC-15: guardar SOLO el hash del token en DB; el token plano va en la URL
    const token = crypto.randomBytes(32).toString('hex');
    const coachPriceId = process.env.STRIPE_COACH_PRICE_ID;

    if (!coachPriceId) {
      logger.error('PAYMENTS', 'STRIPE_COACH_PRICE_ID no definida');
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error de configuración de pagos',
          ...(process.env.NODE_ENV === 'development' && { detail: 'STRIPE_COACH_PRICE_ID no definida en variables de entorno' }), code: 'INTERNAL'},
        { status: 500 }
      );
    }

    // Guardar el pending coach
    const { default: PendingCoach } = await import('@/app/models/PendingCoach');
    await PendingCoach.create({
      token: hashToken(token),
      email: email.toLowerCase().trim(),
      contractAccepted: true,
      contractVersion: contractVersion || '1.0',
      contractAcceptedAt: new Date(),
      paymentStatus: 'pending',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hora
    });

    // Obtener URLs base (dashboard, no confundir con FORM_URL)
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

    // Crear Checkout Session
    const session = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price: coachPriceId,
          quantity: 1,
        },
      ],
      metadata: {
        type: 'coach_subscription',
        pendingCoachToken: token,
        coachEmail: email,
      },
      success_url: `${appUrl}/register/success?token=${token}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/register?canceled=true`,
    });

    logger.info('PAYMENTS', 'Checkout de coach creado', {
      token,
      email,
      sessionId: session.id,
      amount: getCoachSubscriptionAmount(),
    });

    return NextResponse.json(
      {
        success: true,
        url: session.url,
        token,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('PAYMENTS', 'Error creando checkout de coach', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al iniciar el proceso de pago',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
