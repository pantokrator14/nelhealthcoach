// apps/api/src/app/api/admin/finances/export/route.ts
// Exporta datos financieros en formato CSV para QuickBooks/Excel

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import BusinessTransaction, { TAX_CATEGORIES } from '@/app/models/BusinessTransaction';

const VALID_CATEGORIES = TAX_CATEGORIES.map(c => c.key);

function requireAdmin(request: NextRequest): void {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
}

// ─── GET: Exportar CSV ───

async function getHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'all'; // 'income' | 'expense' | 'all'
    const taxYear = parseInt(searchParams.get('taxYear') || String(new Date().getFullYear()), 10);
    const format = searchParams.get('format') || 'quickbooks'; // 'quickbooks' | 'schedule_c'

    const filter: Record<string, unknown> = { taxYear };

    if (type === 'income') {
      filter.type = 'income';
    } else if (type === 'expense') {
      filter.type = 'expense';
    }

    const transactions = await BusinessTransaction.find(filter)
      .sort({ date: -1 })
      .lean()
      .exec();

    if (format === 'schedule_c') {
      // Formato agrupado por categoría fiscal (Schedule C)
      return generateScheduleCFormat(transactions, taxYear);
    }

    // Formato QuickBooks / CSV estándar
    const csvLines: string[] = [];

    // Header
    csvLines.push([
      'Date',
      'Type',
      'Amount',
      'Currency',
      'Description',
      'Category',
      'Schedule C Line',
      'Subcategory',
      'Vendor',
      'Payment Method',
      'Deductible',
      'Deduction %',
      'Source',
      'Notes',
    ].join(','));

    for (const tx of transactions) {
      const categoryInfo = TAX_CATEGORIES.find(c => c.key === tx.category);
      const scheduleCLine = categoryInfo ? `Line ${categoryInfo.scheduleCLine}` : '';

      const row = [
        tx.date ? new Date(tx.date).toISOString().split('T')[0] : '',
        tx.type || '',
        tx.amount ? `$${((tx.amount as number) / 100).toFixed(2)}` : '',
        tx.currency || 'usd',
        escapeCsvCell(tx.description || ''),
        tx.category || '',
        scheduleCLine,
        tx.subcategory || '',
        escapeCsvCell(tx.vendor || ''),
        tx.paymentMethod || '',
        tx.isDeductible ? 'Yes' : 'No',
        tx.deductionPercentage ? `${tx.deductionPercentage}%` : '100%',
        tx.source || '',
        escapeCsvCell(tx.notes || ''),
      ];

      csvLines.push(row.join(','));
    }

    const csvContent = csvLines.join('\n');

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="nelhealthcoach_finances_${taxYear}.csv"`,
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
    logger.error('FINANCES', 'Error exportando datos financieros', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al exportar datos financieros',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── Formato Schedule C (PDF-like como CSV) ───

async function generateScheduleCFormat(
  transactions: Array<Record<string, unknown>>,
  taxYear: number
): Promise<NextResponse> {
  const lines: string[] = [];

  lines.push(`NELHEALTHCOACH, LLC - Schedule C Data - Tax Year ${taxYear}`);
  lines.push('');

  // Income
  const income = transactions.filter(t => t.type === 'income');
  const totalIncome = income.reduce((sum, t) => sum + (t.amount as number || 0), 0);

  lines.push('PART I - INCOME');
  lines.push(`Line 1, Gross receipts or sales,,$${(totalIncome / 100).toFixed(2)}`);
  lines.push('');

  // Expenses by Schedule C line
  const expenses = transactions.filter(t => t.type === 'expense');
  const lineMapping: Record<string, number> = {
    advertising: 8,
    commissions_fees: 10,
    contract_labor: 11,
    legal_professional: 17,
    office_expense: 18,
    supplies: 22,
    taxes_licenses: 23,
    travel: 24,
    meals: 24,
    utilities: 25,
    other_expense: 27,
  };

  lines.push('PART II - EXPENSES');

  const byLine: Record<number, { label: string; total: number; items: Array<{ desc: string; amount: number }> }> = {};

  for (const exp of expenses) {
    const cat = exp.category as string;
    const line = lineMapping[cat] || 27;
    if (!byLine[line]) {
      byLine[line] = {
        label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        total: 0,
        items: [],
      };
    }
    const amount = exp.amount as number || 0;
    const dedPct = (exp.deductionPercentage as number) || 100;
    const deductibleAmount = Math.round(amount * (dedPct / 100));

    byLine[line].total += deductibleAmount;
    byLine[line].items.push({
      desc: exp.description as string || '',
      amount: deductibleAmount,
    });
  }

  const sortedLines = Object.entries(byLine).sort(([a], [b]) => parseInt(a) - parseInt(b));

  for (const [lineNum, data] of sortedLines) {
    const lineNumInt = parseInt(lineNum);
    if (lineNumInt === 24) {
      // Split into 24a (Travel) and 24b (Meals)
      const travel = data.items.filter(i => i.desc.toLowerCase().includes('travel') || i.desc.toLowerCase().includes('transport'));
      const meals = data.items.filter(i => !travel.includes(i));
      if (travel.length > 0) {
        const travelTotal = travel.reduce((s, i) => s + i.amount, 0);
        lines.push(`Line 24a, Travel,$${(travelTotal / 100).toFixed(2)}`);
      }
      if (meals.length > 0) {
        const mealsTotal = meals.reduce((s, i) => s + i.amount, 0);
        lines.push(`Line 24b, Meals (50% deductible),$${(mealsTotal / 100).toFixed(2)}`);
      }
    } else if (lineNumInt === 27) {
      // Itemize other expenses
      lines.push(`Line 27, Other expenses (see attachment),$${(data.total / 100).toFixed(2)}`);
      lines.push('ATTACHMENT - Other Expenses Detail');
      for (const item of data.items) {
        lines.push(`  ,${escapeCsvCell(item.desc)},$${(item.amount / 100).toFixed(2)}`);
      }
    } else {
      lines.push(`Line ${lineNum}, ${data.label},$${(data.total / 100).toFixed(2)}`);
    }
  }

  const totalExpenses = sortedLines.reduce((sum, [, data]) => sum + data.total, 0);
  lines.push(`Line 28, Total expenses,$${(totalExpenses / 100).toFixed(2)}`);
  lines.push('');
  lines.push(`Line 31, Net profit or (loss),$${((totalIncome - totalExpenses) / 100).toFixed(2)}`);

  const csvContent = lines.join('\n');

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="schedule_c_${taxYear}.csv"`,
    },
  });
}

function escapeCsvCell(value: string): string {
  if (!value) return '';
  // If contains comma, quote, or newline, wrap in quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const GET = apiHandler(getHandler);
