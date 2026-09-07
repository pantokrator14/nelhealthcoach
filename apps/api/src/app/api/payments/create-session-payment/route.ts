// apps/api/src/app/api/payments/create-session-payment/route.ts
// Crea un Checkout Session para pagar una sesión pendiente (Flow A y B)
// El pago va directamente al coach via Stripe Connect si tiene cuenta configurada.
// El coach define su propio precio por sesión.

import { NextRequest, NextResponse } from 'next/server';
import { stripeClient } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import PendingSession from '@/app/models/PendingSession';
import Coach from '@/app/models/Coach';
import { safeDecrypt } from '@/app/lib/encryption';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/payments/create-session-payment
 *
 * Body: { pendingSessionId }
 *
 * Crea un Checkout Session de Stripe para que el cliente pague
 * la sesión pendiente. Usa el precio que el coach definió en Finanzas.
 * Si el coach tiene Stripe Connect activo, el pago va directo a su cuenta.
 *
 * No requiere autenticación porque el cliente accede desde el link
 * que el coach le envía. La seguridad está en el pendingSessionId
 * (MongoDB ObjectId, difícil de adivinar) y las validaciones de
 * estado y expiración de la sesión pendiente.
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();

    const body = await request.json();
    const { pendingSessionId } = body as { pendingSessionId?: string };

    if (!pendingSessionId || typeof pendingSessionId !== 'string') {
      return NextResponse.json(
        { success: false, message: 'pendingSessionId es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Buscar la sesión pendiente
    const pending = await PendingSession.findById(pendingSessionId);

    if (!pending) {
      return NextResponse.json(
        { success: false, message: 'Sesión pendiente no encontrada', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (pending.status !== 'awaiting_payment') {
      return NextResponse.json(
        { success: false, message: 'Esta sesión ya no está pendiente de pago', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    if (pending.expiresAt < new Date()) {
      return NextResponse.json(
        { success: false, message: 'El tiempo para pagar esta sesión ha expirado', code: 'VALIDATION'},
        { status: 410 }
      );
    }

    // ─── Obtener info del coach ───
    const coach = await Coach.findById(pending.coachId);
    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Precio por sesión:
    // - Admin: usa el precio fijo del sistema (CLIENT_SESSION_AMOUNT), sin Connect
    // - Coach normal: usa su precio configurado, con Connect si está activo
    const isAdmin = coach.role === 'admin';
    const defaultAmountCents = (Number(process.env.CLIENT_SESSION_AMOUNT) || 150) * 100;
    const coachPriceCents = isAdmin ? defaultAmountCents : (coach.sessionPrice || defaultAmountCents);

    // Nombre del coach para mostrar en el checkout
    const coachName = coach.firstName
      ? safeDecrypt(coach.firstName as string)
      : 'Coach';

    // Stripe Connect: solo coaches no-admin con onboarding completo
    const connectAccountId = (!isAdmin && coach.stripeConnectAccountId && coach.stripePayoutsEnabled)
      ? coach.stripeConnectAccountId
      : null;

    // Obtener URLs base
    const formUrl = process.env.FORM_URL || 'http://localhost:3002';

    // ─── Construir Checkout Session ───
    const sessionConfig: Record<string, unknown> = {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: pending.clientEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Sesión de coaching con ${coachName}`,
              description: `Sesión de ${pending.duration || 60} minutos`,
            },
            unit_amount: coachPriceCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: 'client_session',
        pendingSessionId: pending._id.toString(),
        clientId: pending.clientId,
        clientEmail: pending.clientEmail,
        coachId: pending.coachId,
      },
      success_url: `${formUrl}/thank-you?payment=success&pendingSessionId=${pending._id}`,
      cancel_url: `${formUrl}/request-session?canceled=true`,
    };

    // Si el coach tiene Stripe Connect, el pago va directo a su cuenta
    if (connectAccountId) {
      sessionConfig.payment_intent_data = {
        transfer_data: {
          destination: connectAccountId,
        },
      };

      logger.info('PAYMENTS', 'Checkout con transferencia directa al coach', {
        pendingSessionId,
        coachId: pending.coachId,
        amount: coachPriceCents,
        connectAccountId,
      });
    } else {
      logger.info('PAYMENTS', 'Coach sin Connect — el pago va a la cuenta de la plataforma', {
        pendingSessionId,
        coachId: pending.coachId,
        amount: coachPriceCents,
      });
    }

    const session = await stripeClient.checkout.sessions.create(
      sessionConfig as unknown as Record<string, unknown>
    ) as unknown as Record<string, unknown>;

    logger.info('PAYMENTS', 'Checkout de sesión creado', {
      pendingSessionId,
      sessionId: session.id as string,
      amount: coachPriceCents,
      hasConnectTransfer: !!connectAccountId,
    });

    return NextResponse.json(
      {
        success: true,
        url: session.url as string,
        sessionId: session.id as string,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('PAYMENTS', 'Error creando checkout de sesión', error as Error);
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
