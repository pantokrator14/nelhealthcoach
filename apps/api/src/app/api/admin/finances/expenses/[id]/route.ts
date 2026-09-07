// apps/api/src/app/api/admin/finances/expenses/[id]/route.ts
// GET, PUT, DELETE de un gasto individual

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import BusinessTransaction from '@/app/models/BusinessTransaction';
import { TAX_CATEGORIES, type TaxCategoryKey } from '@/app/models/BusinessTransaction';

const VALID_CATEGORIES = TAX_CATEGORIES.map(c => c.key) as TaxCategoryKey[];

function isValidCategory(cat: string): cat is TaxCategoryKey {
  return (VALID_CATEGORIES as readonly string[]).includes(cat);
}

function requireAdmin(request: NextRequest): void {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
}

// ─── GET: Obtener gasto por ID ───

async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { id } = await params;
    const transaction = await BusinessTransaction.findById(id).lean().exec();

    if (!transaction) {
      return NextResponse.json(
        { success: false, message: 'Gasto no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: transaction });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error obteniendo gasto', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al obtener el gasto',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── PUT: Actualizar gasto ───

async function putHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const existing = await BusinessTransaction.findById(id);
    if (!existing) {
      return NextResponse.json(
        { success: false, message: 'Gasto no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (existing.source !== 'manual') {
      return NextResponse.json(
        { success: false, message: 'No se puede editar una transacción automática', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // ─── Validar campos permitidos ───
    const allowedFields = [
      'amount', 'date', 'description', 'category', 'subcategory',
      'vendor', 'paymentMethod', 'notes', 'isRecurring', 'recurringPeriod',
      'isDeductible', 'deductionPercentage',
    ];

    const updates: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        switch (field) {
          case 'amount':
            if (typeof body.amount === 'number' && body.amount > 0) {
              updates.amount = body.amount;
            }
            break;
          case 'date':
            if (typeof body.date === 'string') {
              updates.date = new Date(body.date);
              updates.taxYear = new Date(body.date).getFullYear();
            }
            break;
          case 'category':
            if (typeof body.category === 'string' && isValidCategory(body.category)) {
              updates.category = body.category;
            }
            break;
          case 'isRecurring':
            updates.isRecurring = body.isRecurring === true;
            break;
          case 'recurringPeriod':
            if (body.recurringPeriod === 'monthly' || body.recurringPeriod === 'quarterly' || body.recurringPeriod === 'annually') {
              updates.recurringPeriod = body.recurringPeriod;
            } else {
              updates.recurringPeriod = undefined;
            }
            break;
          default:
            if (typeof body[field] === 'string' || typeof body[field] === 'boolean' || typeof body[field] === 'number') {
              updates[field] = body[field];
            } else if (body[field] === null || body[field] === undefined) {
              updates[field] = undefined;
            }
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { success: false, message: 'No hay campos válidos para actualizar', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const updated = await BusinessTransaction.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean().exec();

    logger.info('FINANCES', `Gasto actualizado: ${id}`);

    return NextResponse.json({ success: true, data: updated });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error actualizando gasto', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al actualizar el gasto',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── DELETE: Eliminar gasto ───

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { id } = await params;

    const existing = await BusinessTransaction.findById(id);
    if (!existing) {
      return NextResponse.json(
        { success: false, message: 'Gasto no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (existing.source !== 'manual') {
      return NextResponse.json(
        { success: false, message: 'No se puede eliminar una transacción automática', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    await BusinessTransaction.findByIdAndDelete(id);

    logger.info('FINANCES', `Gasto eliminado: ${id}`);

    return NextResponse.json({ success: true, message: 'Gasto eliminado correctamente' });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error eliminando gasto', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al eliminar el gasto',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);
export const PUT = apiHandler(putHandler);
export const DELETE = apiHandler(deleteHandler);
