// apps/api/src/app/api/trial/convert/route.ts
// Convierte una cuenta trial a suscripción paga usando el PaymentMethod guardado

import { NextRequest, NextResponse } from 'next/server';
import Coach from '@/app/models/Coach';
import { requireCoachAuth } from '@/app/lib/auth';
import { stripeClient, getCoachSubscriptionAmount } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { decrypt, encrypt } from '@/app/lib/encryption';
import { apiHandler } from '@/app/lib/apiHandler';

const SUBSCRIPTION_PRICE_ID = process.env.STRIPE_COACH_PRICE_ID;

/**
 * POST /api/trial/convert
 *
 * Autenticación requerida.
 * Cobra la suscripción usando el PaymentMethod guardado del trial.
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);

    if (!SUBSCRIPTION_PRICE_ID) {
      logger.error('PAYMENTS', 'STRIPE_COACH_PRICE_ID no definida');
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error de configuración de pagos',
          ...(process.env.NODE_ENV === 'development' && { detail: 'STRIPE_COACH_PRICE_ID no definida en variables de entorno' }), code: 'INTERNAL'},
        { status: 500 }
      );
    }

    const coach = await Coach.findById(auth.coachId);
    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (coach.trialStatus !== 'active' && coach.trialStatus !== 'expired') {
      return NextResponse.json(
        { success: false, message: 'Esta acción solo está disponible para cuentas en período de prueba', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Obtener datos desencriptados
    const email = decrypt(coach.email);
    const paymentMethodId = coach.trialPaymentMethodId ? decrypt(coach.trialPaymentMethodId) : '';
    const existingCustomerId = coach.stripeCustomerId ? decrypt(coach.stripeCustomerId) : '';

    if (!paymentMethodId) {
      return NextResponse.json(
        { success: false, message: 'No se encontró un método de pago guardado. Por favor, contacta al administrador.', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Crear o reutilizar Stripe Customer
    let customerId = existingCustomerId;
    if (!customerId || !customerId.startsWith('cus_')) {
      const customer = await stripeClient.customers.create({
        email,
        metadata: { coachId: auth.coachId },
        payment_method: paymentMethodId,
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });
      customerId = customer.id;
    } else {
      // Attach payment method si no está ya attachado
      try {
        await stripeClient.paymentMethods.attach(paymentMethodId, { customer: customerId });
        await stripeClient.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
      } catch {
        // Puede que ya esté attachado, continuamos
      }
    }

    // Crear suscripción
    const subscription = await stripeClient.subscriptions.create({
      customer: customerId,
      items: [{ price: SUBSCRIPTION_PRICE_ID }],
      default_payment_method: paymentMethodId,
      metadata: {
        coachId: auth.coachId,
        type: 'coach_subscription',
      },
      off_session: true,
      payment_behavior: 'default_incomplete',
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription',
      },
    });

    // Actualizar coach
    const encryptedCustomerId = encrypt(customerId);
    const encryptedSubscriptionId = encrypt(subscription.id);

    coach.stripeCustomerId = encryptedCustomerId;
    coach.subscriptionId = encryptedSubscriptionId;
    coach.subscriptionStatus = 'active';
    coach.trialStatus = 'converted';
    coach.isActive = true;
    await coach.save();

    logger.info('PAYMENTS', 'Coach convertido de trial a suscripción paga', {
      coachId: auth.coachId,
      subscriptionId: subscription.id,
      customerId,
    });

    return NextResponse.json({
      success: true,
      message: 'Suscripción activada exitosamente. ¡Bienvenido a NELHEALTHCOACH!',
      data: {
        subscriptionId: subscription.id,
        status: subscription.status,
      },
    });
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }
    logger.error('PAYMENTS', 'Error convirtiendo trial', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al procesar el pago de la suscripción. Verifica tu método de pago.',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
