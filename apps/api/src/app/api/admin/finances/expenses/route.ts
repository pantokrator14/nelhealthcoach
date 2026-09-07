// apps/api/src/app/api/admin/finances/expenses/route.ts
// CRUD de gastos manuales del negocio (solo admin)
// Incluye subida de recibos (multipart)

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import BusinessTransaction from '@/app/models/BusinessTransaction';
import { TAX_CATEGORIES, type TaxCategoryKey } from '@/app/models/BusinessTransaction';

// ─── Helpers ───

const VALID_CATEGORIES = TAX_CATEGORIES.map(c => c.key) as TaxCategoryKey[];

function isValidCategory(cat: string): cat is TaxCategoryKey {
  return (VALID_CATEGORIES as readonly string[]).includes(cat);
}

const EXPENSE_FIELDS = [
  'amount',
  'date',
  'description',
  'category',
  'subcategory',
  'vendor',
  'paymentMethod',
  'notes',
  'isRecurring',
  'recurringPeriod',
  'isDeductible',
  'deductionPercentage',
] as const;

type ExpenseInput = Partial<Record<typeof EXPENSE_FIELDS[number], unknown>>;

function validateExpenseInput(body: Record<string, unknown>): ExpenseInput | string {
  const errors: string[] = [];

  if (!body.amount || typeof body.amount !== 'number' || body.amount <= 0) {
    errors.push('amount debe ser un número positivo (en cents)');
  }
  if (!body.date || typeof body.date !== 'string') {
    errors.push('date es requerido (ISO string)');
  }
  if (!body.description || typeof body.description !== 'string' || body.description.trim().length === 0) {
    errors.push('description es requerido');
  }
  if (!body.category || typeof body.category !== 'string' || !isValidCategory(body.category)) {
    errors.push(`category debe ser uno de: ${VALID_CATEGORIES.join(', ')}`);
  }

  if (errors.length > 0) {
    return errors.join('; ');
  }

  const input: ExpenseInput = {};
  for (const field of EXPENSE_FIELDS) {
    if (body[field] !== undefined) {
      (input as Record<string, unknown>)[field] = body[field];
    }
  }

  return input;
}

// ─── Auth: solo admin ───

function requireAdmin(request: NextRequest): { coachId: string } {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
  return { coachId: auth.coachId };
}

// ─── POST: Crear gasto ───

async function postHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const body = (await request.json()) as Record<string, unknown>;
    const validationResult = validateExpenseInput(body);

    if (typeof validationResult === 'string') {
      return NextResponse.json(
        { success: false, message: validationResult, code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const data = validationResult as ExpenseInput;

    const taxYear = new Date(data.date as string).getFullYear();

    // Meals son 50% deducibles por defecto
    const isMeals = data.category === 'meals';
    const deductionPercentage = data.deductionPercentage ?? (isMeals ? 50 : 100);
    const isDeductible = data.isDeductible ?? true;

    const transaction = await BusinessTransaction.create({
      type: 'expense',
      source: 'manual',
      amount: data.amount,
      currency: 'usd',
      date: new Date(data.date as string),
      description: (data.description as string).trim(),
      category: data.category as TaxCategoryKey,
      subcategory: (data.subcategory as string) || 'other',
      vendor: (data.vendor as string) || undefined,
      paymentMethod: (data.paymentMethod as string) || undefined,
      notes: (data.notes as string) || undefined,
      isRecurring: data.isRecurring === true,
      recurringPeriod: data.recurringPeriod === 'monthly' || data.recurringPeriod === 'quarterly' || data.recurringPeriod === 'annually'
        ? data.recurringPeriod
        : undefined,
      isDeductible,
      deductionPercentage,
      taxYear,
    });

    logger.info('FINANCES', `Gasto creado: ${data.description} (${((data.amount as number) / 100).toFixed(2)})`, {
      transactionId: String(transaction._id),
      category: data.category,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: String(transaction._id),
        ...transaction.toObject(),
      },
    });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error creando gasto', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al crear el gasto',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── GET: Listar gastos ───

async function getHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const taxYear = searchParams.get('taxYear');
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const sortBy = searchParams.get('sortBy') || 'date';
    const sortOrder = searchParams.get('sortOrder') === 'asc' ? 1 : -1;

    const filter: Record<string, unknown> = {
      type: 'expense',
      source: 'manual',
    };

    if (category && isValidCategory(category)) {
      filter.category = category;
    }

    if (taxYear) {
      filter.taxYear = parseInt(taxYear, 10);
    }

    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter.$gte = new Date(from);
      if (to) dateFilter.$lte = new Date(to);
      filter.date = dateFilter;
    }

    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      BusinessTransaction.find(filter)
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      BusinessTransaction.countDocuments(filter),
    ]);

    // Calcular totales por categoría
    const categoryTotals = await BusinessTransaction.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$category',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]);

    const totalAmount = transactions.reduce(
      (sum, t) => sum + (t.amount || 0),
      0
    );

    return NextResponse.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        totals: {
          totalAmount,
          categoryTotals,
        },
      },
    });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error listando gastos', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al listar gastos',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
export const GET = apiHandler(getHandler);
