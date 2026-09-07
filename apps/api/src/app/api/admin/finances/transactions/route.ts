// apps/api/src/app/api/admin/finances/transactions/route.ts
// Lista unificada de transacciones: ingresos automáticos (plataforma) + gastos manuales

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import BusinessTransaction, { TAX_CATEGORIES, type TaxCategoryKey } from '@/app/models/BusinessTransaction';
import PendingSession from '@/app/models/PendingSession';
import SubscriptionPayment from '@/app/models/SubscriptionPayment';
import StripePayout from '@/app/models/StripePayout';
import { stripeClient } from '@/app/lib/stripe';

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

// ─── GET: Listar transacciones unificadas ───

async function getHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type'); // 'income' | 'expense' | null (all)
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const taxYear = parseInt(searchParams.get('taxYear') || String(new Date().getFullYear()), 10);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const category = searchParams.get('category');
    const source = searchParams.get('source'); // 'platform_auto' | 'manual' | null

    // ─── 1. Sincronizar transacciones automáticas de la plataforma ───
    await syncPlatformTransactions(taxYear);

    // ─── 2. Construir filtro ───
    const filter: Record<string, unknown> = {};
    if (type && (type === 'income' || type === 'expense')) {
      filter.type = type;
    }
    if (taxYear) {
      filter.taxYear = taxYear;
    }
    if (category && isValidCategory(category)) {
      filter.category = category;
    }
    if (source && (source === 'platform_auto' || source === 'manual')) {
      filter.source = source;
    }
    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter.$gte = new Date(from);
      if (to) dateFilter.$lte = new Date(to);
      filter.date = dateFilter;
    }

    // ─── 3. Consultar ───
    const skip = (page - 1) * limit;

    const [transactions, total, incomeTotal, expenseTotal] = await Promise.all([
      BusinessTransaction.find(filter)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      BusinessTransaction.countDocuments(filter),
      BusinessTransaction.aggregate([
        { $match: { ...filter, type: 'income' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      BusinessTransaction.aggregate([
        { $match: { ...filter, type: 'expense' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

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
          incomeTotal: incomeTotal[0]?.total || 0,
          expenseTotal: expenseTotal[0]?.total || 0,
          netTotal: (incomeTotal[0]?.total || 0) - (expenseTotal[0]?.total || 0),
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
    logger.error('FINANCES', 'Error listando transacciones', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al listar transacciones',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── Sincronizar transacciones de la plataforma ───

async function syncPlatformTransactions(taxYear: number): Promise<void> {
  const startOfYear = new Date(taxYear, 0, 1);
  const endOfYear = new Date(taxYear + 1, 0, 1);

  // 1. Ingresos por sesiones (PendingSession)
  const paidSessions = await PendingSession.find({
    status: { $in: ['paid', 'completed'] },
    paymentConfirmedAt: { $gte: startOfYear, $lt: endOfYear },
  }).lean().exec() as Array<Record<string, unknown>>;

  const defaultAmountCents = (Number(process.env.CLIENT_SESSION_AMOUNT) || 150) * 100;

  for (const session of paidSessions) {
    const existing = await BusinessTransaction.findOne({
      'platformReference.model': 'PendingSession',
      'platformReference.modelId': String(session._id),
    }).exec();

    if (!existing) {
      await BusinessTransaction.create({
        type: 'income',
        source: 'platform_auto',
        amount: defaultAmountCents,
        currency: 'usd',
        date: session.paymentConfirmedAt || session.createdAt,
        description: `Sesión: ${(session.clientName as string) || 'Cliente'}`,
        category: 'platform_income',
        subcategory: 'sessions',
        vendor: 'Stripe',
        isDeductible: true,
        deductionPercentage: 100,
        taxYear,
        platformReference: {
          model: 'PendingSession',
          modelId: String(session._id),
        },
      });
    }
  }

  // 2. Ingresos por suscripciones (SubscriptionPayment)
  const subscriptionPayments = await SubscriptionPayment.find({
    paidAt: { $gte: startOfYear, $lt: endOfYear },
  }).lean().exec() as Array<Record<string, unknown>>;

  for (const sp of subscriptionPayments) {
    const existing = await BusinessTransaction.findOne({
      'platformReference.model': 'SubscriptionPayment',
      'platformReference.modelId': String(sp._id),
    }).exec();

    if (!existing) {
      await BusinessTransaction.create({
        type: 'income',
        source: 'platform_auto',
        amount: sp.amount as number,
        currency: 'usd',
        date: sp.paidAt as Date,
        description: 'Suscripción coach',
        category: 'platform_income',
        subcategory: 'subscriptions',
        vendor: 'Stripe',
        isDeductible: true,
        deductionPercentage: 100,
        taxYear,
        platformReference: {
          model: 'SubscriptionPayment',
          modelId: String(sp._id),
          stripeId: sp.invoiceId as string,
        },
      });
    }
  }

  // 3. Stripe fees (gasto) - calcular estimado basado en transacciones
  // Las tarifas de Stripe son ~2.9% + $0.30 por transacción
  const allIncome = await BusinessTransaction.find({
    source: 'platform_auto',
    taxYear,
    type: 'income',
    category: 'platform_income',
  }).lean().exec();

  const totalIncome = allIncome.reduce((sum, t) => sum + (t.amount || 0), 0);
  const transactionCount = allIncome.length;

  // Stripe fee estimado
  const estimatedStripeFee = Math.round(totalIncome * 0.029 + transactionCount * 30);

  const existingStripeFee = await BusinessTransaction.findOne({
    category: 'commissions_fees',
    subcategory: 'stripe_fees',
    taxYear,
    source: 'platform_auto',
  }).exec();

  if (existingStripeFee) {
    // Actualizar el monto estimado
    await BusinessTransaction.findByIdAndUpdate(existingStripeFee._id, {
      $set: { amount: estimatedStripeFee },
    }).exec();
  } else {
    await BusinessTransaction.create({
      type: 'expense',
      source: 'platform_auto',
      amount: estimatedStripeFee,
      currency: 'usd',
      date: new Date(taxYear, 11, 31),
      description: 'Stripe fees (estimado)',
      category: 'commissions_fees',
      subcategory: 'stripe_fees',
      vendor: 'Stripe',
      isDeductible: true,
      deductionPercentage: 100,
      taxYear,
    });
  }
}

export const GET = apiHandler(getHandler);
