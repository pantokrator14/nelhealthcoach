// apps/api/src/app/api/trial/cancel/route.ts
// Cancela la cuenta trial: elimina el coach y todos sus clientes

import { NextRequest, NextResponse } from 'next/server';
import Coach from '@/app/models/Coach';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { connectMongoose, getHealthFormsCollection } from '@/app/lib/database';
import { stripeClient } from '@/app/lib/stripe';
import { decrypt } from '@/app/lib/encryption';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * POST /api/trial/cancel
 *
 * Autenticación requerida.
 * Elimina el coach autenticado y todos sus clientes.
 * También cancela cualquier PaymentMethod/Cliente en Stripe si existe.
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);

    const coach = await Coach.findById(auth.coachId);
    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Verificar que sea un coach en trial
    if (coach.trialStatus !== 'active' && coach.trialStatus !== 'expired') {
      return NextResponse.json(
        { success: false, message: 'Esta acción solo está disponible para cuentas en período de prueba', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // 1. Eliminar todos los clientes asociados a este coach
    try {
      const healthForms = await getHealthFormsCollection();
      const deleteResult = await healthForms.deleteMany({ coachId: auth.coachId });
      logger.info('TRIAL', 'Clientes eliminados por cancelación de trial', {
        coachId: auth.coachId,
        deletedCount: deleteResult.deletedCount,
      });
    } catch (deleteError) {
      logger.error('TRIAL', 'Error eliminando clientes del coach', deleteError as Error);
      // Continuamos aunque falle la eliminación de clientes
    }

    // 2. Eliminar datos de Stripe si existen
    try {
      if (coach.stripeCustomerId) {
        const customerId = decrypt(coach.stripeCustomerId);
        if (customerId && customerId.startsWith('cus_')) {
          // No eliminamos el customer de Stripe, solo los métodos de pago
          const paymentMethods = await stripeClient.customers.listPaymentMethods(customerId);
          for (const pm of paymentMethods.data) {
            await stripeClient.paymentMethods.detach(pm.id);
          }
        }
      }
    } catch (stripeError) {
      logger.warn('TRIAL', 'Error limpiando datos de Stripe', stripeError as Error);
    }

    // 3. Eliminar el coach
    await Coach.findByIdAndDelete(auth.coachId);

    logger.info('TRIAL', 'Cuenta trial cancelada y eliminada', {
      coachId: auth.coachId,
      email: coach.email ? decrypt(coach.email) : 'unknown',
    });

    return NextResponse.json({
      success: true,
      message: 'Tu cuenta y datos de clientes han sido eliminados exitosamente.',
    });
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }
    logger.error('TRIAL', 'Error cancelando trial', error as Error);
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
