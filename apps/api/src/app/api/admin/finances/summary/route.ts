// apps/api/src/app/api/admin/finances/summary/route.ts
// KPIs financieros para el dashboard del admin

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import BusinessTransaction from '@/app/models/BusinessTransaction';

function requireAdmin(request: NextRequest): void {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
}

// ─── GET: KPIs financieros ───

async function getHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || 'ytd'; // ytd | this_quarter | last_quarter | custom
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    // ─── Calcular rango de fechas ───
    const now = new Date();
    let from: Date;
    let to: Date = new Date(now);

    if (fromParam && toParam) {
      from = new Date(fromParam);
      to = new Date(toParam);
    } else if (period === 'this_quarter') {
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      from = new Date(now.getFullYear(), quarterStartMonth, 1);
    } else if (period === 'last_quarter') {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const lastQuarterStartMonth = currentQuarter === 0 ? 9 : (currentQuarter - 1) * 3;
      const lastQuarterYear = currentQuarter === 0 ? now.getFullYear() - 1 : now.getFullYear();
      from = new Date(lastQuarterYear, lastQuarterStartMonth, 1);
      to = new Date(lastQuarterYear, lastQuarterStartMonth + 3, 0);
    } else {
      // YTD o default
      from = new Date(now.getFullYear(), 0, 1);
    }

    // ─── Ejecutar sync de transacciones de plataforma ───
    await syncTransactionsForRange(from, to);

    // ─── KPIs principales ───
    const filter = {
      date: { $gte: from, $lte: to },
    };

    const [incomeResult, expenseResult, monthlyBreakdown, categoryBreakdown] = await Promise.all([
      // Total income
      BusinessTransaction.aggregate([
        { $match: { ...filter, type: 'income' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      // Total expenses
      BusinessTransaction.aggregate([
        { $match: { ...filter, type: 'expense' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      // Monthly breakdown
      BusinessTransaction.aggregate([
        { $match: filter },
        {
          $group: {
            _id: {
              year: { $year: '$date' },
              month: { $month: '$date' },
              type: '$type',
            },
            total: { $sum: '$amount' },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
      // By category
      BusinessTransaction.aggregate([
        { $match: { ...filter, type: 'expense' } },
        {
          $group: {
            _id: '$category',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ]),
    ]);

    // ─── Construir monthly breakdown ───
    const monthlyMap = new Map<string, { income: number; expense: number }>();

    // Inicializar todos los meses del rango
    let cursor = new Date(from);
    while (cursor <= to) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap.set(key, { income: 0, expense: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    for (const item of monthlyBreakdown) {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      const existing = monthlyMap.get(key) || { income: 0, expense: 0 };
      if (item._id.type === 'income') {
        existing.income += item.total;
      } else {
        existing.expense += item.total;
      }
      monthlyMap.set(key, existing);
    }

    const totalIncome = incomeResult[0]?.total || 0;
    const totalExpense = expenseResult[0]?.total || 0;
    const netIncome = totalIncome - totalExpense;

    // ─── Impuesto estimado (simple: ~30% de neto para CA + Federal) ───
    const estimatedTaxRate = 0.30; // 15.3% SE tax + ~15% income tax (estimado simple)
    const estimatedTax = Math.round(netIncome * estimatedTaxRate);

    // ─── Cálculo LLC Annual Fee de California ───
    const llcAnnualFee = calculateCaliforniaLLCFee(totalIncome);

    return NextResponse.json({
      success: true,
      data: {
        period: {
          from: from.toISOString(),
          to: to.toISOString(),
          label: period,
        },
        income: {
          total: totalIncome,
          count: incomeResult[0]?.count || 0,
        },
        expenses: {
          total: totalExpense,
          count: expenseResult[0]?.count || 0,
        },
        netIncome,
        estimatedTax,
        llcAnnualFee,
        monthlyBreakdown: Array.from(monthlyMap.entries()).map(([month, data]) => ({
          month,
          income: data.income,
          expense: data.expense,
        })),
        categoryBreakdown,
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
    logger.error('FINANCES', 'Error obteniendo resumen financiero', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al obtener resumen financiero',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── Helpers ───

async function syncTransactionsForRange(from: Date, to: Date): Promise<void> {
  // Sincronizar transacciones automáticas de la plataforma
  const PendingSession = (await import('@/app/models/PendingSession')).default;
  const SubscriptionPayment = (await import('@/app/models/SubscriptionPayment')).default;

  const defaultAmountCents = (Number(process.env.CLIENT_SESSION_AMOUNT) || 150) * 100;

  // Sesiones pagadas
  const paidSessions = await PendingSession.find({
    status: { $in: ['paid', 'completed'] },
    paymentConfirmedAt: { $gte: from, $lte: to },
  }).lean().exec() as Array<Record<string, unknown>>;

  for (const session of paidSessions) {
    const existing = await BusinessTransaction.findOne({
      'platformReference.model': 'PendingSession',
      'platformReference.modelId': String(session._id),
    }).exec();

    if (!existing) {
      const date = session.paymentConfirmedAt || session.createdAt;
      await BusinessTransaction.create({
        type: 'income',
        source: 'platform_auto',
        amount: defaultAmountCents,
        currency: 'usd',
        date,
        description: `Sesión: ${(session.clientName as string) || 'Cliente'}`,
        category: 'platform_income',
        subcategory: 'sessions',
        vendor: 'Stripe',
        isDeductible: true,
        deductionPercentage: 100,
        taxYear: new Date(date as string).getFullYear(),
        platformReference: {
          model: 'PendingSession',
          modelId: String(session._id),
        },
      });
    }
  }

  // Suscripciones
  const subscriptionPayments = await SubscriptionPayment.find({
    paidAt: { $gte: from, $lte: to },
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
        taxYear: new Date(sp.paidAt as string).getFullYear(),
        platformReference: {
          model: 'SubscriptionPayment',
          modelId: String(sp._id),
          stripeId: sp.invoiceId as string,
        },
      });
    }
  }
}

function calculateCaliforniaLLCFee(totalIncomeCents: number): {
  amount: number;
  tier: string;
} {
  const totalIncome = totalIncomeCents / 100; // convertir a dólares

  if (totalIncome <= 0) {
    return { amount: 0, tier: 'No income' };
  }
  if (totalIncome <= 250000) {
    return { amount: 800, tier: '$0 - $250,000' };
  }
  if (totalIncome <= 499999) {
    return { amount: 900, tier: '$250,000 - $499,999' };
  }
  if (totalIncome <= 999999) {
    return { amount: 1200, tier: '$500,000 - $999,999' };
  }
  if (totalIncome <= 4999999) {
    return { amount: 3000, tier: '$1,000,000 - $4,999,999' };
  }
  return { amount: 6000, tier: '$5,000,000+' };
}

export const GET = apiHandler(getHandler);
