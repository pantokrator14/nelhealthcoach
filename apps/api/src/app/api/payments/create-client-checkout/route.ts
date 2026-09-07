// apps/api/src/app/api/payments/create-client-checkout/route.ts
// Crea un Checkout Session de Stripe para pago de sesión de cliente

import { NextRequest, NextResponse } from 'next/server';
import { stripeClient, getClientSessionAmount } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/payments/create-client-checkout
 *
 * Body:
 *   - type: 'onboarding' | 'session_renewal'
 *   - clientId?: string (para session_renewal)
 *   - clientEmail?: string
 *   - pendingSessionId?: string (para session_renewal)
 *   - returnUrl?: string (opcional, URL de retorno)
 *
 * Crea un Checkout Session de Stripe (one-time payment).
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();

    const body = await request.json();
    const {
      type,
      clientId,
      clientEmail,
      pendingSessionId,
      returnUrl,
      coachId,
    } = body as {
      type?: 'onboarding' | 'session_renewal';
      clientId?: string;
      clientEmail?: string;
      pendingSessionId?: string;
      returnUrl?: string;
      coachId?: string;
    };

    const paymentType = type || 'onboarding';

    // Validaciones
    if (paymentType === 'session_renewal' && !pendingSessionId) {
      return NextResponse.json(
        { success: false, message: 'pendingSessionId es requerido para renovación', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const clientPriceId = process.env.STRIPE_CLIENT_PRICE_ID;
    if (!clientPriceId) {
      logger.error('PAYMENTS', 'STRIPE_CLIENT_PRICE_ID no definida');
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error de configuración de pagos',
          ...(process.env.NODE_ENV === 'development' && { detail: 'STRIPE_CLIENT_PRICE_ID no definida en variables de entorno' }), code: 'INTERNAL'},
        { status: 500 }
      );
    }

    // Construir metadata según el tipo
    const metadata: Record<string, string> = {
      type: paymentType === 'onboarding' ? 'client_onboarding' : 'client_session',
    };

    if (paymentType === 'session_renewal' && pendingSessionId) {
      metadata.pendingSessionId = pendingSessionId;
    }

    if (clientEmail) {
      metadata.clientEmail = clientEmail;
    }

    if (coachId) {
      metadata.coachId = coachId;
    }

    if (clientId) {
      metadata.clientId = clientId;
    }

    // Obtener URLs base
    const formUrl = process.env.FORM_URL || 'http://localhost:3002';
    // Incluir {CHECKOUT_SESSION_ID} para que Stripe lo reemplace con el ID real
    const successUrl = returnUrl
      ? `${returnUrl}?payment=success&session_id={CHECKOUT_SESSION_ID}`
      : `${formUrl}/thank-you?payment=success&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl = returnUrl
      ? `${returnUrl}?payment=canceled`
      : `${formUrl}/?payment=canceled`;

    // Crear Checkout Session
    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: clientEmail || undefined,
      line_items: [
        {
          price: clientPriceId,
          quantity: 1,
        },
      ],
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    logger.info('PAYMENTS', 'Checkout de cliente creado', {
      type: paymentType,
      sessionId: session.id,
      amount: getClientSessionAmount(),
      pendingSessionId: pendingSessionId || null,
    });

    return NextResponse.json(
      {
        success: true,
        url: session.url,
        sessionId: session.id,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('PAYMENTS', 'Error creando checkout de cliente', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al iniciar el pago',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
