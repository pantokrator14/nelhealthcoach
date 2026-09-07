// apps/api/src/app/api/payments/session-price/route.ts
// Actualiza el precio por sesión del coach

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * PUT /api/payments/session-price
 *
 * Body:
 *   - price: number (precio en centavos USD, ej. 20000 = $200.00)
 *
 * Guarda el precio por sesión que el coach desea cobrar.
 */
async function putHandler(request: NextRequest) {
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

    const body = await request.json();
    const { price } = body as { price?: number };

    if (price === undefined || price === null) {
      return NextResponse.json(
        { success: false, message: 'El precio es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    if (typeof price !== 'number' || price < 5000 || price > 100000) {
      return NextResponse.json(
        { success: false, message: 'El precio debe ser entre $50 y $1,000 USD', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const { default: Coach } = await import('@/app/models/Coach');
    const coach = await Coach.findById(auth.coachId);

    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Validar que tenga Stripe conectado
    if (!coach.stripeConnectAccountId) {
      return NextResponse.json(
        { success: false, message: 'Debes conectar Stripe antes de fijar un precio', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    coach.sessionPrice = price;
    await coach.save();

    logger.info('STRIPE_CONNECT', 'Precio de sesión actualizado', {
      coachId: auth.coachId,
      price,
    });

    return NextResponse.json({
      success: true,
      message: 'Precio actualizado exitosamente',
      data: { sessionPrice: price },
    });
  } catch (error: unknown) {
    logger.error('STRIPE_CONNECT', 'Error actualizando precio de sesión', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al actualizar el precio',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const PUT = apiHandler(putHandler);
