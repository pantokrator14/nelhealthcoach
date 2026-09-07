// apps/api/src/app/api/auth/trial/confirm-verification/route.ts
// Confirmación manual de verificación de tarjeta (trial)
// Se llama desde la página /dashboard/trial/verify-card después del redirect de Stripe
// Esto evita depender exclusivamente del webhook (que en dev requiere Stripe CLI)

import { NextRequest, NextResponse } from 'next/server';
import Coach from '@/app/models/Coach';
import { stripeClient } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { encrypt, decrypt } from '@/app/lib/encryption';
import { connectMongoose } from '@/app/lib/database';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';

async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();

    const body = await request.json();
    const { coachId, sessionId } = body as {
      coachId?: string;
      sessionId?: string;
    };

    // Request context for audit logs
    const reqCtx = {
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
    };

    if (!coachId || !sessionId) {
      return NextResponse.json(
        { success: false, message: 'coachId y sessionId son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // 1. Verificar que el coach existe
    const coach = await Coach.findById(coachId);
    if (!coach) {
      logAuditEvent({
        eventType: 'VERIFICATION_FAILURE',
        severity: 'warning',
        message: `Confirmación de trial: coach no encontrado (${coachId})`,
        ...reqCtx,
        path: '/api/auth/trial/confirm-verification',
        method: 'POST',
        statusCode: 404,
      });
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // 2. Si ya está activo, responder éxito directamente
    if (coach.isActive) {
      return NextResponse.json({
        success: true,
        message: 'Tu cuenta ya está activa.',
        alreadyActive: true,
      });
    }

    // 3. Recuperar la sesión de Stripe para verificar el pago
    let session;
    try {
      session = await stripeClient.checkout.sessions.retrieve(sessionId);
    } catch (stripeError) {
      logger.error('PAYMENTS', 'Error recuperando sesión de Stripe', stripeError as Error);
      return NextResponse.json(
        { success: false, message: 'No se pudo verificar la sesión de pago. Intenta de nuevo o contacta a soporte.', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // 4. Validar la sesión
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      logger.warn('PAYMENTS', 'Sesión de Stripe no está pagada', {
        sessionId,
        paymentStatus: session.payment_status,
        coachId: coach._id.toString(),
      });
      return NextResponse.json(
        { success: false, message: 'El pago no fue completado. Intenta de nuevo.', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const metadata = session.metadata as Record<string, string> | undefined;
    if (!metadata || metadata.type !== 'trial_verification') {
      logger.warn('PAYMENTS', 'Sesión de Stripe no es de tipo trial_verification', {
        sessionId,
        metadataType: metadata?.type,
        coachId: coach._id.toString(),
      });
      return NextResponse.json(
        { success: false, message: 'Sesión de pago inválida para verificación de trial.', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Verificar que el email de la sesión coincide con el coach
    const coachEmail = coach.email ? decrypt(coach.email as string) : '';
    if (session.customer_email && session.customer_email !== coachEmail) {
      logger.warn('PAYMENTS', 'Email de sesión Stripe no coincide con coach', {
        sessionEmail: session.customer_email,
        coachEmail,
        coachId: coach._id.toString(),
      });
      // No bloquear, pero registrar
    }

    // 5. Activar el coach
    const paymentIntentId = session.payment_intent as string | null;
    const customerId = session.customer as string | null;

    // Obtener PaymentMethod y Customer desde el PaymentIntent
    let paymentMethodId = '';
    let finalCustomerId = customerId || '';
    if (paymentIntentId) {
      try {
        const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);
        if (paymentIntent.payment_method) {
          paymentMethodId = String(paymentIntent.payment_method);
        }
        if (!finalCustomerId && paymentIntent.customer) {
          finalCustomerId = String(paymentIntent.customer);
        }
      } catch {
        logger.warn('PAYMENTS', 'No se pudo obtener datos del PaymentIntent');
      }
    }

    // Si no hay customer en Stripe, crear uno
    if (!finalCustomerId && coachEmail) {
      try {
        const newCustomer = await stripeClient.customers.create({
          email: coachEmail,
          metadata: { coachId: coach._id.toString() },
        });
        finalCustomerId = newCustomer.id;
      } catch (customerError) {
        logger.error('PAYMENTS', 'Error creando Stripe Customer', customerError as Error);
      }
    }

    // Adjuntar PaymentMethod al Customer
    if (paymentMethodId && finalCustomerId) {
      try {
        await stripeClient.paymentMethods.attach(paymentMethodId, {
          customer: finalCustomerId,
        });
        await stripeClient.customers.update(finalCustomerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });
      } catch (pmError) {
        logger.error('PAYMENTS', 'Error adjuntando PaymentMethod al Customer', pmError as Error);
      }
    }

    // Activar coach y marcar email como verificado
    coach.isActive = true;
    coach.emailVerified = true;
    coach.verificationToken = null;
    if (finalCustomerId) {
      coach.stripeCustomerId = encrypt(finalCustomerId);
    }
    if (paymentIntentId) {
      coach.trialPaymentIntentId = encrypt(paymentIntentId);
    }
    if (paymentMethodId) {
      coach.trialPaymentMethodId = encrypt(paymentMethodId);
    }
    await coach.save();

    logger.info('PAYMENTS', 'Coach activado después de verificación trial (confirmación manual)', {
      coachId: coach._id.toString(),
      sessionId,
      hasPaymentMethod: !!paymentMethodId,
    });

    logAuditEvent({
      eventType: 'TRIAL_CARD_VERIFIED',
      severity: 'info',
      message: `Coach activado por verificación manual de tarjeta: ${coachEmail}`,
      coachId: coach._id.toString(),
      actorEmail: coachEmail,
      actorRole: 'coach',
      ...reqCtx,
      path: '/api/auth/trial/confirm-verification',
      method: 'POST',
      statusCode: 200,
      metadata: { sessionId },
    });

    // Enviar email de bienvenida al trial
    try {
      const { EmailService } = await import('@/app/lib/email-service');
      const emailService = EmailService.getInstance();
      const coachName = coach.firstName ? decrypt(coach.firstName as string) : 'Coach';

      await emailService.sendTrialWelcomeEmail(
        coachEmail,
        coachName,
        coach.trialEndDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      );
    } catch (emailError) {
      logger.error('PAYMENTS', 'Error enviando email de bienvenida trial', emailError as Error);
    }

    return NextResponse.json({
      success: true,
      message: 'Todo listo. Ya puedes iniciar sesión y empezar a trabajar.',
    });
  } catch (error: unknown) {
    logger.error('AUTH', 'Error en confirm-verification', error instanceof Error ? error : new Error(String(error)));
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
