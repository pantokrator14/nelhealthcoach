// apps/api/src/app/api/admin/finances/reports/route.ts
// Genera datos estructurados para formularios fiscales:
//   - Schedule C (Federal - Form 1040)
//   - Form 568 (California)
//   - Quarterly estimated tax

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import BusinessTransaction, { TAX_CATEGORIES } from '@/app/models/BusinessTransaction';

function requireAdmin(request: NextRequest): void {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
}

// ─── POST: Generar reporte ───

async function postHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const body = (await request.json()) as Record<string, unknown>;
    const reportType = body.type as string; // 'schedule_c' | 'form_568' | 'quarterly'
    const year = (body.year as number) || new Date().getFullYear();

    if (!reportType || !['schedule_c', 'form_568', 'quarterly'].includes(reportType)) {
      return NextResponse.json(
        { success: false, message: 'Tipo de reporte inválido. Use: schedule_c, form_568, quarterly', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    switch (reportType) {
      case 'schedule_c':
        return await generateScheduleC(year);
      case 'form_568':
        return await generateForm568(year);
      case 'quarterly':
        return await generateQuarterlyTax(year);
      default:
        return NextResponse.json(
          { success: false, message: 'Tipo de reporte no implementado', code: 'VALIDATION'},
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error generando reporte fiscal', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al generar reporte fiscal',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── Schedule C (Form 1040) ───

async function generateScheduleC(year: number) {
  const filter = { taxYear: year };

  // Income by category
  const incomeByCategory = await BusinessTransaction.aggregate([
    { $match: { ...filter, type: 'income' } },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);

  // Expense by category (mapeado a Schedule C lines)
  const expenseByCategory = await BusinessTransaction.aggregate([
    { $match: { ...filter, type: 'expense' } },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);

  // Other expenses detallados (Line 27 items)
  const otherExpenses = await BusinessTransaction.find({
    ...filter,
    type: 'expense',
    category: 'other_expense',
  }).sort({ amount: -1 }).lean().exec();

  // Meals (50% deductible)
  const mealsTotal = await BusinessTransaction.aggregate([
    { $match: { ...filter, type: 'expense', category: 'meals' } },
    { $group: { _id: null, total: { $sum: '$amount' }, deductibleTotal: { $sum: { $multiply: ['$amount', { $divide: ['$deductionPercentage', 100] }] } } } },
  ]);

  const totalIncome = incomeByCategory.reduce((sum, c) => sum + c.total, 0);
  const totalExpenses = expenseByCategory.reduce((sum, c) => sum + c.total, 0);
  const netProfit = totalIncome - totalExpenses;

  // ─── Construir líneas del Schedule C ───
  const scheduleCLines: Array<{ line: number; label: string; amount: number; items?: Array<{ description: string; amount: number }> }> = [];

  // Part I: Income
  scheduleCLines.push({ line: 1, label: 'Gross receipts or sales', amount: totalIncome });

  // Part II: Expenses
  const lineMapping: Record<string, { line: number; label: string }> = {
    advertising: { line: 8, label: 'Advertising' },
    commissions_fees: { line: 10, label: 'Commissions and fees' },
    contract_labor: { line: 11, label: 'Contract labor' },
    legal_professional: { line: 17, label: 'Legal and professional services' },
    office_expense: { line: 18, label: 'Office expense' },
    supplies: { line: 22, label: 'Supplies' },
    taxes_licenses: { line: 23, label: 'Taxes and licenses' },
    travel: { line: 24, label: 'Travel' },
    meals: { line: 24, label: 'Meals (50% deductible)' },
    utilities: { line: 25, label: 'Utilities' },
    other_expense: { line: 27, label: 'Other expenses' },
  };

  for (const cat of expenseByCategory) {
    const mapping = lineMapping[cat._id];
    if (mapping) {
      let amount = cat.total;
      if (cat._id === 'meals' && mealsTotal[0]) {
        amount = Math.round(mealsTotal[0].deductibleTotal);
      }
      scheduleCLines.push({ line: mapping.line, label: mapping.label, amount });
    }
  }

  // Itemizar Other expenses (Line 27)
  const groupedOther: Record<string, number> = {};
  for (const exp of otherExpenses) {
    const key = TAX_CATEGORIES.find(c => c.key === 'other_expense') ? 'Other' : exp.description;
    const subcat = (exp.subcategory || 'other').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    const label = `${subcat}: ${exp.description}`;
    groupedOther[label] = (groupedOther[label] || 0) + (exp.amount || 0);
  }

  const line27Item = scheduleCLines.find(l => l.line === 27);
  if (line27Item && Object.keys(groupedOther).length > 0) {
    line27Item.items = Object.entries(groupedOther).map(([description, amount]) => ({
      description,
      amount,
    }));
  }

  // Total expenses (Line 28)
  scheduleCLines.push({ line: 28, label: 'Total expenses', amount: totalExpenses });

  // Net profit (Line 31)
  scheduleCLines.push({ line: 31, label: 'Net profit or (loss)', amount: netProfit });

  // Self-employment tax (aproximación simple: Schedule SE)
  const seTaxRate = 0.153; // 15.3%
  const seTaxDeduction = Math.round(netProfit * 0.5 * 0.153); // Deducción del SE tax
  const seTax = Math.round(netProfit * seTaxRate);

  return NextResponse.json({
    success: true,
    data: {
      type: 'schedule_c',
      year,
      totalIncome,
      totalExpenses,
      netProfit,
      selfEmploymentTax: seTax,
      selfEmploymentTaxDeduction: seTaxDeduction,
      lines: scheduleCLines,
      categoryDetail: {
        income: incomeByCategory,
        expenses: expenseByCategory,
      },
      otherExpensesDetail: groupedOther,
    },
  });
}

// ─── Form 568 (California LLC) ───

async function generateForm568(year: number) {
  const filter = { taxYear: year };

  const [incomeResult, expenseResult] = await Promise.all([
    BusinessTransaction.aggregate([
      { $match: { ...filter, type: 'income' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    BusinessTransaction.aggregate([
      { $match: { ...filter, type: 'expense', isDeductible: true } },
      { $group: { _id: null, total: { $sum: { $multiply: ['$amount', { $divide: ['$deductionPercentage', 100] }] } } } },
    ]),
  ]);

  const totalIncome = incomeResult[0]?.total || 0;
  const totalDeductibleExpenses = expenseResult[0]?.total || 0;
  const netIncome = totalIncome - totalDeductibleExpenses;

  // LLC Annual Fee (California)
  const totalIncomeDollars = totalIncome / 100;
  let llcFee = 800;
  if (totalIncomeDollars > 250000) llcFee = 900;
  if (totalIncomeDollars > 500000) llcFee = 1200;
  if (totalIncomeDollars > 1000000) llcFee = 3000;
  if (totalIncomeDollars > 5000000) llcFee = 6000;

  return NextResponse.json({
    success: true,
    data: {
      type: 'form_568',
      year,
      totalIncome,
      totalDeductibleExpenses,
      netIncome,
      californiaLLCFee: {
        amount: llcFee * 100, // en cents
        amountDollars: llcFee,
        tier: getCaliforniaLLCFeeTier(totalIncomeDollars),
      },
      estimatedTaxableIncome: netIncome,
    },
  });
}

// ─── Quarterly Estimated Tax ───

async function generateQuarterlyTax(year: number) {
  const filter = { taxYear: year };

  const quarters = [
    { label: 'Q1 (Jan-Mar)', months: [0, 1, 2] },
    { label: 'Q2 (Apr-Jun)', months: [3, 4, 5] },
    { label: 'Q3 (Jul-Sep)', months: [6, 7, 8] },
    { label: 'Q4 (Oct-Dec)', months: [9, 10, 11] },
  ];

  const quarterlyData = [];

  for (const quarter of quarters) {
    const startMonth = quarter.months[0];
    const endMonth = quarter.months[2];
    const startDate = new Date(year, startMonth, 1);
    const endDate = new Date(year, endMonth + 1, 0);

    const [income, expenses] = await Promise.all([
      BusinessTransaction.aggregate([
        {
          $match: {
            date: { $gte: startDate, $lte: endDate },
            type: 'income',
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      BusinessTransaction.aggregate([
        {
          $match: {
            date: { $gte: startDate, $lte: endDate },
            type: 'expense',
            isDeductible: true,
          },
        },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', { $divide: ['$deductionPercentage', 100] }] } } } },
      ]),
    ]);

    const quarterIncome = income[0]?.total || 0;
    const quarterExpenses = expenses[0]?.total || 0;
    const quarterNet = quarterIncome - quarterExpenses;

    quarterlyData.push({
      quarter: quarter.label,
      income: quarterIncome,
      expenses: quarterExpenses,
      netIncome: quarterNet,
      estimatedTax: Math.round(quarterNet * 0.30), // ~30% combined rate
    });
  }

  const totalNetYTD = quarterlyData.reduce((sum, q) => sum + q.netIncome, 0);

  return NextResponse.json({
    success: true,
    data: {
      type: 'quarterly',
      year,
      quarters: quarterlyData,
      totalNetYTD,
      totalEstimatedTaxYTD: Math.round(totalNetYTD * 0.30),
      notes: [
        'Federal estimated tax: ~15.3% SE tax + income tax bracket',
        'California estimated tax: ~9.3% (CA marginal rate)',
        'These are estimates. Consult a CPA for accurate tax planning.',
      ],
    },
  });
}

function getCaliforniaLLCFeeTier(totalIncomeDollars: number): string {
  if (totalIncomeDollars <= 250000) return '$0 - $250,000';
  if (totalIncomeDollars <= 499999) return '$250,000 - $499,999';
  if (totalIncomeDollars <= 999999) return '$500,000 - $999,999';
  if (totalIncomeDollars <= 4999999) return '$1,000,000 - $4,999,999';
  return '$5,000,000+';
}

export const POST = apiHandler(postHandler);
