import React, { useState, useEffect, useCallback } from 'react';
import Layout from '../../../components/dashboard/Layout';
import Head from 'next/head';
import { useToast } from '../../../components/ui/Toast';
import { apiClient, FinancesData } from '../../../lib/api';
import { translateApiError } from '@/lib/apiErrorText';

import { useTranslation } from 'react-i18next';

// ═══════════════════════════════════════════════
// ─── Types ───
// ═══════════════════════════════════════════════

interface AdminSummaryData {
  period: { from: string; to: string; label: string };
  income: { total: number; count: number };
  expenses: { total: number; count: number };
  netIncome: number;
  estimatedTax: number;
  llcAnnualFee: number;
  monthlyBreakdown: Array<{ month: string; income: number; expense: number }>;
  categoryBreakdown: Array<{ _id: string; total: number; count: number }>;
}

interface ExpenseTransaction {
  _id: string;
  type: 'income' | 'expense';
  source: 'platform_auto' | 'manual';
  amount: number;
  date: string;
  description: string;
  category: string;
  subcategory: string;
  vendor?: string;
  paymentMethod?: string;
  notes?: string;
  taxYear: number;
  isDeductible: boolean;
  deductionPercentage: number;
  receiptFile?: { s3Key: string; originalName: string } | null;
  createdAt: string;
}

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ScheduleCReport {
  type: string;
  year: number;
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  selfEmploymentTax: number;
  selfEmploymentTaxDeduction: number;
  lines: Array<{ line: number; label: string; amount: number; items?: Array<{ description: string; amount: number }> }>;
}

type AdminTab = 'dashboard' | 'income' | 'expenses' | 'taxes';

// ═══════════════════════════════════════════════
// ─── Helpers ───
// ═══════════════════════════════════════════════

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatShortMonth(monthKey: string): string {
  const [y, m] = monthKey.split('-');
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${months[parseInt(m, 10) - 1]} ${y.slice(2)}`;
}

function getCategoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    advertising: 'Advertising',
    commissions_fees: 'Commissions & Fees',
    contract_labor: 'Contract Labor',
    legal_professional: 'Legal & Professional',
    office_expense: 'Office Expense',
    supplies: 'Supplies',
    taxes_licenses: 'Taxes & Licenses',
    travel: 'Travel',
    meals: 'Meals',
    utilities: 'Utilities',
    other_expense: 'Other Expenses',
    platform_income: 'Platform Income',
    other_income: 'Other Income',
  };
  return labels[cat] || cat;
}

function getSubcategoryLabel(sub: string): string {
  const labels: Record<string, string> = {
    ai_apis: 'AI APIs',
    cloud_hosting: 'Cloud Hosting',
    database: 'Database',
    email_service: 'Email Service',
    video_service: 'Video Service',
    domain_names: 'Domain Names',
    development: 'Development',
    dev_tools: 'Dev Tools',
    insurance: 'Insurance',
    bank_fees: 'Bank Fees',
    stripe_fees: 'Stripe Fees',
    software_saas: 'Software SaaS',
    office_supplies: 'Office Supplies',
    equipment: 'Equipment',
    sessions: 'Sessions',
    subscriptions: 'Subscriptions',
    other: 'Other',
  };
  return labels[sub] || sub.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ═══════════════════════════════════════════════
// ─── Coach View (existing page) ───
// ═══════════════════════════════════════════════

const COLORS = {
  primary: 'purple',
  income: '#22c55e',
  expense: '#ef4444',
  subscription: '#6366f1',
};

function CoachFinancesPage() {
  const { t } = useTranslation();
  const { showToast, ToastComponent } = useToast();

  const [data, setData] = useState<FinancesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'6m' | '12m' | 'all'>('12m');
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [savingPrice, setSavingPrice] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiClient.getFinances(period);
      if (res.success && res.data) {
        setData(res.data);
        if (!res.data.sesionPriceFijo) {
          setPriceInput(String((res.data.sesionPrice / 100).toFixed(0)));
        }
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'finances.errorLoad'), 'error');
    } finally {
      setLoading(false);
    }
  }, [period, showToast, t]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSavePrice = async () => {
    const priceNum = parseInt(priceInput, 10);
    if (isNaN(priceNum) || priceNum < 10 || priceNum > 9999) {
      showToast(t('finances.errorInvalidPrice'), 'error');
      return;
    }
    try {
      setSavingPrice(true);
      const res = await apiClient.updateSessionPrice(priceNum * 100);
      if (res.success) {
        showToast(t('finances.priceUpdated'), 'success');
        setEditingPrice(false);
        setData(prev => prev ? { ...prev, sesionPrice: priceNum * 100 } : prev);
      } else {
        showToast(translateApiError(res, t, 'finances.errorSave'), 'error');
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'finances.errorSavePrice'), 'error');
    } finally {
      setSavingPrice(false);
    }
  };

  const getBarChart = () => {
    if (!data?.breakdownMensual || data.breakdownMensual.length === 0) return null;
    const maxVal = Math.max(
      ...data.breakdownMensual.map(m => Math.max(m.ingresos, m.suscripcion)),
      1
    );
    return data.breakdownMensual.map((item) => {
      const ingH = maxVal > 0 ? (item.ingresos / maxVal) * 100 : 0;
      const subH = maxVal > 0 ? (item.suscripcion / maxVal) * 100 : 0;
      return (
        <div key={item.month} className="flex flex-col items-center gap-1 flex-1 min-w-[48px]">
          <div className="relative w-full flex justify-center gap-0.5" style={{ height: '140px' }}>
            <div
              className="w-3 rounded-t transition-all duration-500 self-end"
              style={{ height: `${Math.max(ingH, 2)}%`, backgroundColor: COLORS.income }}
              title={t('finances.chartTooltipIncome', { month: formatShortMonth(item.month), amount: formatCents(item.ingresos) })}
            />
            <div
              className="w-3 rounded-t transition-all duration-500 self-end"
              style={{ height: `${Math.max(subH, 2)}%`, backgroundColor: data.isAdmin ? '#6366f1' : COLORS.expense }}
              title={t('finances.chartTooltipSubs', { month: formatShortMonth(item.month), amount: formatCents(item.suscripcion) })}
            />
          </div>
          <span className="text-xs text-gray-500 whitespace-nowrap">{formatShortMonth(item.month)}</span>
        </div>
      );
    });
  };

  return (
    <>
      <Head><title>{t('finances.title')} - NELHEALTHCOACH</title></Head>
      <Layout>
        <div className="p-8">
          <ToastComponent />
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-8">
            <div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-500 rounded-xl flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <h1 className="text-3xl font-bold text-purple-700">{t('finances.title')}</h1>
                  <p className="text-purple-500">{t('finances.subtitleCoach')}</p>
                </div>
              </div>
            </div>
            <div className="flex gap-2 bg-white rounded-xl shadow-sm p-1 w-full sm:w-auto">
              {(['6m', '12m', 'all'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    period === p ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-600 hover:bg-purple-50'
                  }`}
                >
                  {p === '6m' ? t('finances.period6m') : p === '12m' ? t('finances.period12m') : t('finances.periodAll')}
                </button>
              ))}
            </div>
          </div>

          {loading && (
            <div className="flex justify-center py-20">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
            </div>
          )}

          {!loading && data && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-medium text-gray-500">{t('finances.cardSessionsCoach')}</span>
                    <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-3xl font-bold text-gray-800">{formatCents(data.summary.totalBruto)}</p>
                  <p className="text-sm text-gray-500 mt-1">{t('finances.sessionsCount', { count: data.summary.sesionesCompletadas })}</p>
                </div>

                <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-medium text-gray-500">{t('finances.cardSubscriptionsCoach')}</span>
                    <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-3xl font-bold text-gray-800">{formatCents(data.summary.totalSuscripcion)}</p>
                  <p className="text-sm text-gray-500 mt-1">{t('finances.monthsCount', { count: data.suscripcion?.mesesSuscrito ?? 0 })}</p>
                </div>

                <div className="bg-white rounded-xl shadow-sm p-6 border border-purple-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-medium text-purple-600">{t('finances.totalNet')}</span>
                    <div className="w-9 h-9 bg-purple-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-3xl font-bold text-purple-700">{formatCents(data.summary.totalObtenido)}</p>
                  <p className="text-sm text-gray-500 mt-1">{t('finances.totalBreakdownCoach')}</p>
                </div>

                <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-medium text-gray-500">{t('finances.pricePerSession')}</span>
                    <div className="w-9 h-9 bg-purple-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                  </div>
                  {data.sesionPriceFijo ? (
                    <div className="flex items-center gap-2">
                      <p className="text-3xl font-bold text-gray-800">{formatCents(data.sesionPrice)}</p>
                      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{t('finances.priceFixed')}</span>
                    </div>
                  ) : editingPrice ? (
                    <div className="flex items-center gap-2">
                      <span className="text-lg text-gray-500">$</span>
                      <input
                        type="number"
                        value={priceInput}
                        onChange={(e) => setPriceInput(e.target.value)}
                        className="w-24 px-2 py-1 border border-purple-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-xl font-bold"
                        min="10" max="9999" autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSavePrice(); if (e.key === 'Escape') setEditingPrice(false); }}
                      />
                      <button onClick={handleSavePrice} disabled={savingPrice}
                        className="px-3 py-1.5 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 disabled:opacity-50 transition">
                        {savingPrice ? '...' : 'Save'}
                      </button>
                      <button onClick={() => setEditingPrice(false)}
                        className="px-3 py-1.5 text-gray-500 text-sm rounded-lg hover:bg-gray-100 transition">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="text-3xl font-bold text-gray-800">{formatCents(data.sesionPrice)}</p>
                      <button
                        onClick={() => { setPriceInput(String((data.sesionPrice / 100).toFixed(0))); setEditingPrice(true); }}
                        className="p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition"
                        title={t('finances.priceEditTitle')}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-gray-400 mt-1">{t('finances.priceChargedToClient')}</p>
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
                <h2 className="text-lg font-semibold text-gray-800 mb-2">{t('finances.chartTitleCoach')}</h2>
                <div className="flex items-center gap-4 mb-6 text-sm">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded" style={{ backgroundColor: COLORS.income }} />
                    <span className="text-gray-600">{t('finances.chartLegendIncome')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded" style={{ backgroundColor: COLORS.expense }} />
                    <span className="text-gray-600">{t('finances.chartLegendSubsCoach')}</span>
                  </div>
                </div>
                <div className="flex items-end gap-2 h-44 overflow-x-auto pb-2">{getBarChart()}</div>
              </div>

              <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
                <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('finances.transactionsTitle')}</h2>
                {data.transaccionesRecientes.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">{t('finances.transactionsEmpty')}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thClient')}</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thAmount')}</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thDate')}</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thStatus')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.transaccionesRecientes.map((tx) => (
                          <tr key={tx.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                            <td className="py-3 text-sm font-medium text-gray-800">{tx.clientName}</td>
                            <td className="py-3 text-sm text-gray-700">{formatCents(tx.amount)}</td>
                            <td className="py-3 text-sm text-gray-500">{formatDate(tx.date)}</td>
                            <td className="py-3">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                tx.status === 'paid' || tx.status === 'completed'
                                  ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                              }`}>
                                {tx.status === 'paid' || tx.status === 'completed' ? `✅ ${t('finances.statusPaid')}` : tx.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {data.suscripcion && (
                <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
                  <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('finances.subCardTitleCoach')}</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    <div>
                      <span className="text-sm text-gray-500">{t('finances.subStatus')}</span>
                      <p className="text-lg font-semibold mt-1">
                        {data.suscripcion.status === 'active' ? (
                          <span className="text-green-600 flex items-center gap-1.5">
                            <span className="w-2 h-2 bg-green-500 rounded-full inline-block" />
                            {t('finances.subActiveLabel')}
                          </span>
                        ) : data.suscripcion.status === 'past_due' ? (
                          <span className="text-red-600 flex items-center gap-1.5">
                            <span className="w-2 h-2 bg-red-500 rounded-full inline-block" />
                            {t('finances.subOverdue')}
                          </span>
                        ) : (
                          <span className="text-gray-500">{t('finances.subInactive')}</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <span className="text-sm text-gray-500">{t('finances.subMonthlyAmount')}</span>
                      <p className="text-lg font-semibold text-gray-800 mt-1">{formatCents(data.suscripcion.monto)}</p>
                    </div>
                    <div>
                      <span className="text-sm text-gray-500">{t('finances.subMonthsSubscribed')}</span>
                      <p className="text-lg font-semibold text-gray-800 mt-1">{data.suscripcion.mesesSuscrito}</p>
                    </div>
                    <div>
                      <span className="text-sm text-gray-500">{t('finances.subNextBilling')}</span>
                      <p className="text-lg font-semibold text-gray-800 mt-1">
                        {data.suscripcion.currentPeriodEnd
                          ? formatDate(data.suscripcion.currentPeriodEnd)
                          : data.suscripcion.proximoCobro
                            ? formatDate(data.suscripcion.proximoCobro) : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
                <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                  <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M3 10v11M21 10v11" />
                  </svg>
                  {t('finances.payoutsTitle')}
                </h2>
                {data.payouts.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">{t('finances.payoutsEmpty')}</div>
                ) : (
                  <>
                    <div className="bg-blue-50 rounded-lg p-4 mb-4 flex items-center justify-between">
                      <span className="text-sm font-medium text-blue-700">{t('finances.payoutsTotal')}</span>
                      <span className="text-2xl font-bold text-blue-700">{formatCents(data.summary.totalPayouts)}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-gray-100">
                            <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thDescription')}</th>
                            <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thAmount')}</th>
                            <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thArrivalDate')}</th>
                            <th className="pb-3 text-sm font-medium text-gray-500">{t('finances.thStatus')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.payouts.map((po) => (
                            <tr key={po.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                              <td className="py-3 text-sm text-gray-800">{po.description || t('finances.payoutDefaultDesc')}</td>
                              <td className="py-3 text-sm font-medium text-gray-800">{formatCents(po.amount)}</td>
                              <td className="py-3 text-sm text-gray-500">{formatDate(po.arrivalDate)}</td>
                              <td className="py-3">
                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                  po.status === 'paid' ? 'bg-green-100 text-green-700' :
                                  po.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                                  po.status === 'in_transit' ? 'bg-blue-100 text-blue-700' :
                                  po.status === 'failed' ? 'bg-red-100 text-red-700' :
                                  'bg-gray-100 text-gray-600'
                                }`}>
                                  {po.status === 'paid' ? t('finances.payoutStatusPaid') :
                                   po.status === 'pending' ? t('finances.payoutStatusPending') :
                                   po.status === 'in_transit' ? t('finances.payoutStatusInTransit') :
                                   po.status === 'failed' ? t('finances.payoutStatusFailed') :
                                   po.status === 'canceled' ? t('finances.payoutStatusCanceled') : po.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {!loading && !data && (
            <div className="text-center py-20 text-gray-400">{t('finances.errorNoData')}</div>
          )}
        </div>
      </Layout>
    </>
  );
}

// ═══════════════════════════════════════════════
// ─── Admin View (New Tabbed Interface) ───
// ═══════════════════════════════════════════════

function AdminFinancesPage() {
  const { t } = useTranslation();
  const { showToast, ToastComponent } = useToast();

  // ─── Tab state ───
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());

  // ─── Dashboard state ───
  const [summary, setSummary] = useState<AdminSummaryData | null>(null);
  const [summaryPeriod, setSummaryPeriod] = useState<'ytd' | 'this_quarter' | 'last_quarter'>('ytd');
  const [summaryLoading, setSummaryLoading] = useState(true);

  // ─── Expenses state ───
  const [expenses, setExpenses] = useState<ExpenseTransaction[]>([]);
  const [expensesPagination, setExpensesPagination] = useState<PaginationInfo | null>(null);
  const [expensesLoading, setExpensesLoading] = useState(false);
  const [expensesCategory, setExpensesCategory] = useState('');
  const [expensesPage, setExpensesPage] = useState(1);
  const [showExpenseForm, setShowExpenseForm] = useState(false);

  // ─── Expense form state ───
  const [expenseForm, setExpenseForm] = useState({
    amount: '',
    date: new Date().toISOString().split('T')[0],
    description: '',
    category: 'other_expense',
    subcategory: 'other',
    vendor: '',
    paymentMethod: '',
    notes: '',
    isRecurring: false,
    recurringPeriod: 'monthly',
    isDeductible: true,
    deductionPercentage: 100,
  });
  const [expenseFormSaving, setExpenseFormSaving] = useState(false);
  const [uploadingReceiptId, setUploadingReceiptId] = useState<string | null>(null);

  // ─── Receipt upload handler ───

  const handleUploadReceipt = async (expenseId: string, file: File) => {
    try {
      setUploadingReceiptId(expenseId);

      // Step 1: Generate presigned upload URL
      const urlRes = await apiClient.generateReceiptUploadURL(expenseId, {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      });

      if (!urlRes.success || !urlRes.data) {
        throw new Error(urlRes.message || 'Error al generar URL de upload');
      }

      const { uploadURL, fileKey } = urlRes.data;

      // Step 2: Upload file directly to S3
      const uploadRes = await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });

      if (!uploadRes.ok) {
        throw new Error('Error al subir archivo a S3');
      }

      // Step 3: Confirm upload and save receipt reference
      const confirmRes = await apiClient.confirmReceiptUpload(expenseId, {
        s3Key: fileKey,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
      });

      if (confirmRes.success) {
        showToast(t('adminFinance.receiptUploaded'), 'success');
        loadExpenses();
      } else {
        throw new Error(confirmRes.message || 'Error al confirmar upload');
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.receiptUploadError'), 'error');
    } finally {
      setUploadingReceiptId(null);
    }
  };

  const handleDeleteReceipt = async (expenseId: string) => {
    if (!window.confirm(t('adminFinance.receiptDeleteConfirm'))) return;
    try {
      const res = await apiClient.deleteReceipt(expenseId);
      if (res.success) {
        showToast(t('adminFinance.receiptDeleted'), 'success');
        loadExpenses();
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.receiptDeleteError'), 'error');
    }
  };

  // ─── Income state ───
  const [incomeData, setIncomeData] = useState<{
    transactions: ExpenseTransaction[];
    totals: { incomeTotal: number; expenseTotal: number; netTotal: number };
    pagination: PaginationInfo;
  } | null>(null);
  const [incomeLoading, setIncomeLoading] = useState(false);

  // ─── Tax state ───
  const [reportData, setReportData] = useState<ScheduleCReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportType, setReportType] = useState<'schedule_c' | 'form_568' | 'quarterly'>('schedule_c');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsData, setSettingsData] = useState<Record<string, unknown> | null>(null);

  // ═══════════════════════════════════════════════
  // Tab: Dashboard
  // ═══════════════════════════════════════════════

  const loadSummary = useCallback(async () => {
    try {
      setSummaryLoading(true);
      const res = await apiClient.getAdminFinanceSummary(summaryPeriod);
      if (res.success) {
        setSummary(res.data);
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.errorLoad'), 'error');
    } finally {
      setSummaryLoading(false);
    }
  }, [summaryPeriod, showToast, t]);

  useEffect(() => {
    if (activeTab === 'dashboard') loadSummary();
  }, [activeTab, loadSummary]);

  // ═══════════════════════════════════════════════
  // Tab: Income
  // ═══════════════════════════════════════════════

  const loadIncome = useCallback(async () => {
    try {
      setIncomeLoading(true);
      const res = await apiClient.getAdminFinanceTransactions({ taxYear, page: 1, limit: 20 });
      if (res.success) {
        setIncomeData(res.data);
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.errorLoad'), 'error');
    } finally {
      setIncomeLoading(false);
    }
  }, [taxYear, showToast, t]);

  useEffect(() => {
    if (activeTab === 'income') loadIncome();
  }, [activeTab, loadIncome]);

  // ═══════════════════════════════════════════════
  // Tab: Expenses
  // ═══════════════════════════════════════════════

  const loadExpenses = useCallback(async () => {
    try {
      setExpensesLoading(true);
      const params: Record<string, unknown> = { taxYear, page: expensesPage, limit: 20, sortBy: 'date', sortOrder: 'desc' };
      if (expensesCategory) params.category = expensesCategory;
      const res = await apiClient.getAdminFinanceExpenses(params);
      if (res.success) {
        setExpenses(res.data.transactions);
        setExpensesPagination(res.data.pagination);
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.errorLoad'), 'error');
    } finally {
      setExpensesLoading(false);
    }
  }, [taxYear, expensesPage, expensesCategory, showToast, t]);

  useEffect(() => {
    if (activeTab === 'expenses') loadExpenses();
  }, [activeTab, loadExpenses]);

  // ═══════════════════════════════════════════════
  // Expense form
  // ═══════════════════════════════════════════════

  const handleCreateExpense = async () => {
    const amountNum = Math.round(parseFloat(expenseForm.amount) * 100);
    if (isNaN(amountNum) || amountNum <= 0) {
      showToast(t('adminFinance.expenseAmountInvalid'), 'error');
      return;
    }
    if (!expenseForm.description.trim()) {
      showToast(t('adminFinance.expenseDescriptionRequired'), 'error');
      return;
    }
    try {
      setExpenseFormSaving(true);
      const res = await apiClient.createAdminFinanceExpense({
        amount: amountNum,
        date: expenseForm.date,
        description: expenseForm.description.trim(),
        category: expenseForm.category,
        subcategory: expenseForm.subcategory,
        vendor: expenseForm.vendor || undefined,
        paymentMethod: expenseForm.paymentMethod || undefined,
        notes: expenseForm.notes || undefined,
        isRecurring: expenseForm.isRecurring,
        recurringPeriod: expenseForm.isRecurring ? expenseForm.recurringPeriod : undefined,
        isDeductible: expenseForm.isDeductible,
        deductionPercentage: expenseForm.deductionPercentage,
      });
      if (res.success) {
        showToast(t('adminFinance.expenseCreated'), 'success');
        setShowExpenseForm(false);
        setExpenseForm({
          amount: '',
          date: new Date().toISOString().split('T')[0],
          description: '',
          category: 'other_expense',
          subcategory: 'other',
          vendor: '',
          paymentMethod: '',
          notes: '',
          isRecurring: false,
          recurringPeriod: 'monthly',
          isDeductible: true,
          deductionPercentage: 100,
        });
        loadExpenses();
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.errorCreate'), 'error');
    } finally {
      setExpenseFormSaving(false);
    }
  };

  const handleDeleteExpense = async (id: string) => {
    if (!window.confirm(t('adminFinance.confirmDeleteExpense'))) return;
    try {
      const res = await apiClient.deleteAdminFinanceExpense(id);
      if (res.success) {
        showToast(t('adminFinance.expenseDeleted'), 'success');
        loadExpenses();
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.errorDelete'), 'error');
    }
  };

  // ═══════════════════════════════════════════════
  // Tab: Taxes
  // ═══════════════════════════════════════════════

  const loadReport = useCallback(async () => {
    try {
      setReportLoading(true);
      const res = await apiClient.generateAdminFinanceReport(reportType, taxYear);
      if (res.success) {
        setReportData(res.data);
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'adminFinance.errorLoad'), 'error');
    } finally {
      setReportLoading(false);
    }
  }, [reportType, taxYear, showToast, t]);

  useEffect(() => {
    if (activeTab === 'taxes') loadReport();
  }, [activeTab, loadReport]);

  // ═══════════════════════════════════════════════
  // Settings
  // ═══════════════════════════════════════════════

  const loadSettings = useCallback(async () => {
    try {
      const res = await apiClient.getAdminFinanceSettings();
      if (res.success) {
        setSettingsData(res.data);
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    if (showSettings) loadSettings();
  }, [showSettings, loadSettings]);

  // ═══════════════════════════════════════════════
  // Tabs definition
  // ═══════════════════════════════════════════════

  const tabs: Array<{ key: AdminTab; label: string; icon: string }> = [
    { key: 'dashboard', label: t('adminFinance.tabDashboard'), icon: '📊' },
    { key: 'income', label: t('adminFinance.tabIncome'), icon: '💰' },
    { key: 'expenses', label: t('adminFinance.tabExpenses'), icon: '💳' },
    { key: 'taxes', label: t('adminFinance.tabTaxes'), icon: '📋' },
  ];

  // ═══════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════

  return (
    <>
      <Head><title>Finanzas Admin - NELHEALTHCOACH</title></Head>
      <Layout>
        <div className="p-8">
          <ToastComponent />

          {/* ─── Header ─── */}
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-500 rounded-xl flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-3xl font-bold text-purple-700">{t('finances.title')}</h1>
                <p className="text-purple-500">NELHEALTHCOACH, LLC — {t('finances.subtitleAdmin')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={taxYear}
                onChange={(e) => setTaxYear(parseInt(e.target.value, 10))}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 bg-white shadow-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                {[2024, 2025, 2026, 2027].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition text-sm"
              >
                ⚙️ {t('adminFinance.settings')}
              </button>
            </div>
          </div>

          {/* ─── Settings Panel ─── */}
          {showSettings && (
            <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-6">
              <SettingsPanel settingsData={settingsData} loadSettings={loadSettings} showToast={showToast} t={t} />
            </div>
          )}

          {/* ─── Tabs ─── */}
          <div className="flex gap-1 bg-white rounded-xl shadow-sm p-1 mb-6 overflow-x-auto">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  activeTab === tab.key
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-purple-50'
                }`}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* ═══════════════════════════════════════ */}
          {/* TAB: DASHBOARD */}
          {/* ═══════════════════════════════════════ */}
          {activeTab === 'dashboard' && (
            <>
              <div className="flex gap-2 bg-white rounded-xl shadow-sm p-1 mb-6 w-full sm:w-fit">
                {(['ytd', 'this_quarter', 'last_quarter'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setSummaryPeriod(p)}
                    className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      summaryPeriod === p
                        ? 'bg-purple-600 text-white shadow-sm'
                        : 'text-gray-600 hover:bg-purple-50'
                    }`}
                  >
                    {p === 'ytd' ? t('adminFinance.periodYTD') : p === 'this_quarter' ? t('adminFinance.periodThisQuarter') : t('adminFinance.periodLastQuarter')}
                  </button>
                ))}
              </div>

              {summaryLoading ? (
                <div className="flex justify-center py-20">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
                </div>
              ) : summary ? (
                <>
                  {/* KPI Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                    <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-sm font-medium text-gray-500">{t('adminFinance.totalIncome')}</span>
                        <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">
                          <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                          </svg>
                        </div>
                      </div>
                      <p className="text-3xl font-bold text-green-700">{formatCents(summary.income.total)}</p>
                      <p className="text-sm text-gray-500 mt-1">{summary.income.count} transacciones</p>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-sm font-medium text-gray-500">{t('adminFinance.totalExpenses')}</span>
                        <div className="w-9 h-9 bg-red-100 rounded-lg flex items-center justify-center">
                          <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
                          </svg>
                        </div>
                      </div>
                      <p className="text-3xl font-bold text-red-700">{formatCents(summary.expenses.total)}</p>
                      <p className="text-sm text-gray-500 mt-1">{summary.expenses.count} transacciones</p>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm p-6 border border-purple-100">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-sm font-medium text-purple-600">{t('adminFinance.netIncome')}</span>
                        <div className="w-9 h-9 bg-purple-100 rounded-lg flex items-center justify-center">
                          <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      </div>
                      <p className={`text-3xl font-bold ${summary.netIncome >= 0 ? 'text-purple-700' : 'text-red-700'}`}>
                        {formatCents(summary.netIncome)}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">Income − Expenses</p>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm p-6 border border-amber-100">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-sm font-medium text-amber-600">{t('adminFinance.estimatedTax')}</span>
                        <div className="w-9 h-9 bg-amber-100 rounded-lg flex items-center justify-center">
                          <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                          </svg>
                        </div>
                      </div>
                      <p className="text-3xl font-bold text-amber-700">{formatCents(summary.estimatedTax)}</p>
                      <p className="text-sm text-gray-500 mt-1">CA LLC Fee: {formatCents(summary.llcAnnualFee)}</p>
                    </div>
                  </div>

                  {/* Monthly Chart */}
                  <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
                    <h2 className="text-lg font-semibold text-gray-800 mb-2">Ingresos vs Gastos Mensual</h2>
                    <div className="flex items-center gap-4 mb-6 text-sm">
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded" style={{ backgroundColor: COLORS.income }} />
                        <span className="text-gray-600">Ingresos</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded" style={{ backgroundColor: COLORS.expense }} />
                        <span className="text-gray-600">Gastos</span>
                      </div>
                    </div>
                    <div className="flex items-end gap-2 h-44 overflow-x-auto pb-2">
                      {summary.monthlyBreakdown.map((item) => {
                        const allValues = summary.monthlyBreakdown.flatMap(m => [m.income, m.expense]);
                        const maxVal = Math.max(...allValues, 1);
                        const ingH = (item.income / maxVal) * 100;
                        const expH = (item.expense / maxVal) * 100;
                        return (
                          <div key={item.month} className="flex flex-col items-center gap-1 flex-1 min-w-[48px]">
                            <div className="relative w-full flex justify-center gap-0.5" style={{ height: '140px' }}>
                              <div className="w-3 rounded-t transition-all duration-500 self-end" style={{ height: `${Math.max(ingH, 2)}%`, backgroundColor: COLORS.income }} />
                              <div className="w-3 rounded-t transition-all duration-500 self-end" style={{ height: `${Math.max(expH, 2)}%`, backgroundColor: COLORS.expense }} />
                            </div>
                            <span className="text-xs text-gray-500 whitespace-nowrap">{formatShortMonth(item.month)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Category Breakdown */}
                  {summary.categoryBreakdown.length > 0 && (
                    <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100 mb-8">
                      <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('adminFinance.totalByCategory')}</h2>
                      <div className="space-y-3">
                        {summary.categoryBreakdown.map((cat) => (
                          <div key={cat._id} className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-medium text-gray-700 w-40">{getCategoryLabel(cat._id)}</span>
                              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden w-48">
                                <div
                                  className="h-full bg-purple-500 rounded-full transition-all"
                                  style={{ width: `${Math.min(100, (cat.total / Math.max(...summary.categoryBreakdown.map(c => c.total), 1)) * 100)}%` }}
                                />
                              </div>
                            </div>
                            <span className="text-sm font-semibold text-gray-800">{formatCents(cat.total)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-20 text-gray-400">{t('adminFinance.noData')}</div>
              )}
            </>
          )}

          {/* ═══════════════════════════════════════ */}
          {/* TAB: INCOME */}
          {/* ═══════════════════════════════════════ */}
          {activeTab === 'income' && (
            <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-800">{t('adminFinance.incomeTitle')}</h2>
                <div className="flex gap-2">
                  <a
                    href={apiClient.getAdminFinanceExportURL({ type: 'income', taxYear, format: 'quickbooks' })}
                    className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    📥 {t('adminFinance.exportQuickbooks')}
                  </a>
                </div>
              </div>

              {incomeLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-500" />
                </div>
              ) : incomeData ? (
                <>
                  {/* Income totals */}
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-green-50 rounded-lg p-4">
                      <p className="text-sm text-green-600 font-medium">{t('adminFinance.totalIncome')}</p>
                      <p className="text-2xl font-bold text-green-700">{formatCents(incomeData.totals.incomeTotal)}</p>
                    </div>
                    <div className="bg-red-50 rounded-lg p-4">
                      <p className="text-sm text-red-600 font-medium">{t('adminFinance.totalExpenses')}</p>
                      <p className="text-2xl font-bold text-red-700">{formatCents(incomeData.totals.expenseTotal)}</p>
                    </div>
                    <div className="bg-purple-50 rounded-lg p-4">
                      <p className="text-sm text-purple-600 font-medium">{t('adminFinance.netIncome')}</p>
                      <p className="text-2xl font-bold text-purple-700">{formatCents(incomeData.totals.netTotal)}</p>
                    </div>
                  </div>

                  {/* Income transactions table */}
                  {incomeData.transactions.length === 0 ? (
                    <div className="text-center py-8 text-gray-400">{t('adminFinance.noData')}</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-gray-100">
                            <th className="pb-3 text-sm font-medium text-gray-500">Fecha</th>
                            <th className="pb-3 text-sm font-medium text-gray-500">Descripción</th>
                            <th className="pb-3 text-sm font-medium text-gray-500">Categoría</th>
                            <th className="pb-3 text-sm font-medium text-gray-500">Fuente</th>
                            <th className="pb-3 text-sm font-medium text-gray-500 text-right">Monto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {incomeData.transactions.map((tx: ExpenseTransaction) => (
                            <tr key={tx._id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                              <td className="py-3 text-sm text-gray-500">{formatDate(tx.date)}</td>
                              <td className="py-3 text-sm font-medium text-gray-800">{tx.description}</td>
                              <td className="py-3 text-sm text-gray-600">{getCategoryLabel(tx.category)}</td>
                              <td className="py-3 text-sm text-gray-500">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  tx.source === 'platform_auto' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                                }`}>
                                  {tx.source === 'platform_auto' ? t('adminFinance.platformIncome') : t('adminFinance.manualIncome')}
                                </span>
                              </td>
                              <td className={`py-3 text-sm font-semibold text-right ${tx.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                                {tx.type === 'income' ? '+' : '-'}{formatCents(tx.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {incomeData.pagination && incomeData.pagination.totalPages > 1 && (
                    <div className="flex justify-center gap-2 mt-4">
                      {Array.from({ length: incomeData.pagination.totalPages }, (_, i) => i + 1).map(p => (
                        <button
                          key={p}
                          onClick={async () => {
                            const res = await apiClient.getAdminFinanceTransactions({ taxYear, page: p, limit: 20 });
                            if (res.success) setIncomeData(res.data);
                          }}
                          className={`px-3 py-1 rounded text-sm ${p === incomeData.pagination.page ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-12 text-gray-400">{t('adminFinance.noData')}</div>
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════ */}
          {/* TAB: EXPENSES */}
          {/* ═══════════════════════════════════════ */}
          {activeTab === 'expenses' && (
            <>
              {/* Filters & Add Button */}
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-3">
                  <select
                    value={expensesCategory}
                    onChange={(e) => { setExpensesCategory(e.target.value); setExpensesPage(1); }}
                    className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white shadow-sm focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="">Todas las categorías</option>
                    <option value="advertising">Advertising</option>
                    <option value="commissions_fees">Commissions & Fees</option>
                    <option value="contract_labor">Contract Labor</option>
                    <option value="legal_professional">Legal & Professional</option>
                    <option value="office_expense">Office Expense</option>
                    <option value="taxes_licenses">Taxes & Licenses</option>
                    <option value="meals">Meals</option>
                    <option value="utilities">Utilities</option>
                    <option value="other_expense">Other Expenses</option>
                  </select>
                  <a
                    href={apiClient.getAdminFinanceExportURL({ type: 'expense', taxYear, format: 'quickbooks' })}
                    className="px-3 py-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition text-sm font-medium"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    📥 {t('adminFinance.exportQuickbooks')}
                  </a>
                </div>
                <button
                  onClick={() => setShowExpenseForm(!showExpenseForm)}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm font-medium"
                >
                  {showExpenseForm ? '✕ Cancelar' : `➕ ${t('adminFinance.addExpense')}`}
                </button>
              </div>

              {/* Expense Form */}
              {showExpenseForm && (
                <div className="bg-white rounded-xl shadow-sm p-6 border border-purple-200 mb-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">{t('adminFinance.expenseFormTitle')}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldDate')}</label>
                      <input type="date" value={expenseForm.date}
                        onChange={(e) => setExpenseForm(f => ({ ...f, date: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldAmount')} (USD)</label>
                      <input type="number" step="0.01" min="0" placeholder="0.00" value={expenseForm.amount}
                        onChange={(e) => setExpenseForm(f => ({ ...f, amount: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldCategory')}</label>
                      <select value={expenseForm.category}
                        onChange={(e) => setExpenseForm(f => ({ ...f, category: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
                        <option value="advertising">Advertising</option>
                        <option value="commissions_fees">Commissions & Fees</option>
                        <option value="contract_labor">Contract Labor</option>
                        <option value="legal_professional">Legal & Professional</option>
                        <option value="office_expense">Office Expense</option>
                        <option value="supplies">Supplies</option>
                        <option value="taxes_licenses">Taxes & Licenses</option>
                        <option value="travel">Travel</option>
                        <option value="meals">Meals (50%)</option>
                        <option value="utilities">Utilities</option>
                        <option value="other_expense">Other Expenses</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldSubcategory')}</label>
                      <select value={expenseForm.subcategory}
                        onChange={(e) => setExpenseForm(f => ({ ...f, subcategory: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
                        <option value="ai_apis">AI APIs</option>
                        <option value="cloud_hosting">Cloud Hosting</option>
                        <option value="database">Database</option>
                        <option value="email_service">Email Service</option>
                        <option value="video_service">Video Service</option>
                        <option value="domain_names">Domain Names</option>
                        <option value="development">Development</option>
                        <option value="dev_tools">Dev Tools</option>
                        <option value="insurance">Insurance</option>
                        <option value="stripe_fees">Stripe Fees</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldDescription')}</label>
                      <input type="text" placeholder="Ej: Servicio de IA - Marzo 2026" value={expenseForm.description}
                        onChange={(e) => setExpenseForm(f => ({ ...f, description: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldVendor')}</label>
                      <input type="text" placeholder="Ej: Google Cloud" value={expenseForm.vendor}
                        onChange={(e) => setExpenseForm(f => ({ ...f, vendor: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldPaymentMethod')}</label>
                      <input type="text" placeholder="Ej: Tarjeta de crédito" value={expenseForm.paymentMethod}
                        onChange={(e) => setExpenseForm(f => ({ ...f, paymentMethod: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldDeductionPct')}</label>
                      <select value={expenseForm.deductionPercentage}
                        onChange={(e) => setExpenseForm(f => ({ ...f, deductionPercentage: parseInt(e.target.value, 10) }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
                        <option value={100}>100%</option>
                        <option value={50}>50% (Meals)</option>
                      </select>
                    </div>
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fieldNotes')}</label>
                      <textarea value={expenseForm.notes} rows={2}
                        onChange={(e) => setExpenseForm(f => ({ ...f, notes: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={expenseForm.isRecurring}
                          onChange={(e) => setExpenseForm(f => ({ ...f, isRecurring: e.target.checked }))}
                          className="rounded text-purple-600 focus:ring-purple-500" />
                        <span className="text-sm text-gray-600">{t('adminFinance.fieldRecurring')}</span>
                      </label>
                      {expenseForm.isRecurring && (
                        <select value={expenseForm.recurringPeriod}
                          onChange={(e) => setExpenseForm(f => ({ ...f, recurringPeriod: e.target.value }))}
                          className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white">
                          <option value="monthly">{t('adminFinance.monthly')}</option>
                          <option value="quarterly">{t('adminFinance.quarterly')}</option>
                          <option value="annually">{t('adminFinance.annually')}</option>
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 mt-6">
                    <button onClick={() => setShowExpenseForm(false)}
                      className="px-4 py-2 text-gray-500 rounded-lg hover:bg-gray-100 transition text-sm">
                      Cancel
                    </button>
                    <button onClick={handleCreateExpense} disabled={expenseFormSaving}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition text-sm">
                      {expenseFormSaving ? '...' : '💾 Save'}
                    </button>
                  </div>
                </div>
              )}

              {/* Expenses Table */}
              <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('adminFinance.expensesTitle')}</h2>

                {expensesLoading ? (
                  <div className="flex justify-center py-12">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-500" />
                  </div>
                ) : expenses.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">{t('adminFinance.noExpenses')}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="pb-3 text-sm font-medium text-gray-500">Fecha</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">Descripción</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">Categoría</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">Subcategoría</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">Proveedor</th>
                          <th className="pb-3 text-sm font-medium text-gray-500">{t('adminFinance.fieldReceipt')}</th>
                          <th className="pb-3 text-sm font-medium text-gray-500 text-right">Monto</th>
                          <th className="pb-3 text-sm font-medium text-gray-500 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expenses.map((exp) => (
                          <tr key={exp._id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                            <td className="py-3 text-sm text-gray-500">{formatDate(exp.date)}</td>
                            <td className="py-3 text-sm font-medium text-gray-800">{exp.description}</td>
                            <td className="py-3 text-sm text-gray-600">{getCategoryLabel(exp.category)}</td>
                            <td className="py-3 text-sm text-gray-500">{getSubcategoryLabel(exp.subcategory)}</td>
                            <td className="py-3 text-sm text-gray-500">{exp.vendor || '—'}</td>
                            <td className="py-3 text-sm">
                              {exp.receiptFile ? (
                                <div className="flex items-center gap-1">
                                  <span className="text-xs text-gray-500 truncate max-w-[80px] inline-block" title={exp.receiptFile.originalName}>
                                    {exp.receiptFile.originalName}
                                  </span>
                                  <button
                                    onClick={() => handleDeleteReceipt(exp._id)}
                                    className="p-1 text-gray-400 hover:text-red-600 rounded transition"
                                    title={t('adminFinance.receiptDeleteConfirm')}
                                  >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </button>
                                </div>
                              ) : (
                                <label className={`cursor-pointer inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition ${
                                  uploadingReceiptId === exp._id
                                    ? 'bg-purple-100 text-purple-600 animate-pulse'
                                    : 'bg-gray-100 text-gray-500 hover:bg-purple-100 hover:text-purple-600'
                                }`}>
                                  <input
                                    type="file"
                                    accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
                                    className="hidden"
                                    disabled={uploadingReceiptId !== null}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) handleUploadReceipt(exp._id, file);
                                      e.target.value = '';
                                    }}
                                  />
                                  {uploadingReceiptId === exp._id ? '📤' : '📎'}
                                  <span>{uploadingReceiptId === exp._id ? 'Subiendo...' : t('adminFinance.uploadReceipt')}</span>
                                </label>
                              )}
                            </td>
                            <td className="py-3 text-sm font-semibold text-red-600 text-right">{formatCents(exp.amount)}</td>
                            <td className="py-3 text-right">
                              <button
                                onClick={() => handleDeleteExpense(exp._id)}
                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                                title={t('adminFinance.deleteExpense')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {expensesPagination && expensesPagination.totalPages > 1 && (
                  <div className="flex justify-center gap-2 mt-4">
                    {Array.from({ length: expensesPagination.totalPages }, (_, i) => i + 1).map(p => (
                      <button
                        key={p}
                        onClick={() => setExpensesPage(p)}
                        className={`px-3 py-1 rounded text-sm ${p === expensesPagination.page ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════ */}
          {/* TAB: TAXES */}
          {/* ═══════════════════════════════════════ */}
          {activeTab === 'taxes' && (
            <div>
              {/* Report type selector */}
              <div className="flex gap-2 bg-white rounded-xl shadow-sm p-1 mb-6 w-fit">
                {(['schedule_c', 'form_568', 'quarterly'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setReportType(r)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      reportType === r ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-600 hover:bg-purple-50'
                    }`}
                  >
                    {r === 'schedule_c' ? t('adminFinance.scheduleC') : r === 'form_568' ? t('adminFinance.form568') : t('adminFinance.quarterlyTax')}
                  </button>
                ))}
              </div>

              {/* Report content */}
              <div className="bg-white rounded-xl shadow-sm p-6 border border-gray-100">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-gray-800">
                    {reportType === 'schedule_c' ? t('adminFinance.scheduleC') : reportType === 'form_568' ? t('adminFinance.form568') : t('adminFinance.quarterlyTax')}
                    <span className="text-sm font-normal text-gray-500 ml-2">— Tax Year {taxYear}</span>
                  </h2>
                  <div className="flex gap-2">
                    <a
                      href={apiClient.getAdminFinanceExportURL({ taxYear, format: 'schedule_c' })}
                      className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      📥 {t('adminFinance.downloadScheduleC')}
                    </a>
                    <a
                      href={apiClient.getAdminFinanceExportURL({ taxYear, format: 'quickbooks' })}
                      className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      📥 {t('adminFinance.downloadCSV')}
                    </a>
                    <button
                      onClick={async () => {
                        try {
                          await apiClient.downloadFinanceReportPDF(reportType, taxYear);
                        } catch (err) {
                          showToast(translateApiError(err, t, 'adminFinance.reportDownloadError'), 'error');
                        }
                      }}
                      className="px-3 py-1.5 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition"
                    >
                      📄 {t('adminFinance.downloadPDF')}
                    </button>
                  </div>
                </div>

                {reportLoading ? (
                  <div className="flex justify-center py-12">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-500" />
                  </div>
                ) : reportData ? (
                  <>
                    {/* Summary numbers */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                      <div className="bg-green-50 rounded-lg p-4">
                        <p className="text-xs text-green-600 font-medium uppercase tracking-wide">Gross Income</p>
                        <p className="text-2xl font-bold text-green-700">{formatCents(reportData.totalIncome)}</p>
                      </div>
                      <div className="bg-red-50 rounded-lg p-4">
                        <p className="text-xs text-red-600 font-medium uppercase tracking-wide">Total Expenses</p>
                        <p className="text-2xl font-bold text-red-700">{formatCents(reportData.totalExpenses)}</p>
                      </div>
                      <div className="bg-purple-50 rounded-lg p-4">
                        <p className="text-xs text-purple-600 font-medium uppercase tracking-wide">Net Profit</p>
                        <p className={`text-2xl font-bold ${reportData.netProfit >= 0 ? 'text-purple-700' : 'text-red-700'}`}>
                          {formatCents(reportData.netProfit)}
                        </p>
                      </div>
                      <div className="bg-amber-50 rounded-lg p-4">
                        <p className="text-xs text-amber-600 font-medium uppercase tracking-wide">SE Tax (est.)</p>
                        <p className="text-2xl font-bold text-amber-700">{formatCents(reportData.selfEmploymentTax)}</p>
                      </div>
                    </div>

                    {/* Schedule C Lines */}
                    {reportData.lines && reportData.lines.length > 0 && (
                      <div className="mt-6">
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Schedule C Lines</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead>
                              <tr className="border-b border-gray-200">
                                <th className="pb-2 text-xs font-medium text-gray-500 w-24">Line</th>
                                <th className="pb-2 text-xs font-medium text-gray-500">Description</th>
                                <th className="pb-2 text-xs font-medium text-gray-500 text-right w-32">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {reportData.lines.map((line, idx) => (
                                <React.Fragment key={idx}>
                                  <tr className={line.line === 28 || line.line === 31 ? 'border-t-2 border-gray-300' : 'border-b border-gray-50'}>
                                    <td className={`py-2 text-sm font-mono ${line.line === 31 ? 'font-bold text-purple-700' : 'text-gray-500'}`}>
                                      {line.line === 28 || line.line === 31 ? '' : `Line ${line.line}`}
                                    </td>
                                    <td className={`py-2 text-sm ${line.line === 31 ? 'font-bold text-purple-700' : 'text-gray-800'}`}>
                                      {line.line === 28 ? '─────────────────────────────────' : line.line === 31 ? 'NET PROFIT (LOSS)' : line.label}
                                    </td>
                                    <td className={`py-2 text-sm text-right font-semibold ${line.line === 31 ? 'text-purple-700 text-lg' : 'text-gray-800'}`}>
                                      {line.line === 28 ? '' : formatCents(line.amount)}
                                    </td>
                                  </tr>
                                  {/* Itemized other expenses */}
                                  {line.items && line.items.length > 0 && (
                                    <tr>
                                      <td colSpan={3} className="pl-8 pb-2">
                                        <div className="bg-gray-50 rounded-lg p-3">
                                          <p className="text-xs font-medium text-gray-500 mb-2">Itemized Other Expenses (Line 27 attachment):</p>
                                          {line.items.map((item, iidx) => (
                                            <div key={iidx} className="flex justify-between text-sm py-0.5">
                                              <span className="text-gray-700">{item.description}</span>
                                              <span className="font-medium text-gray-800">{formatCents(item.amount)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-12">
                    <p className="text-gray-400 mb-4">{t('adminFinance.noData')}</p>
                    <button onClick={loadReport}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm">
                      {t('adminFinance.generateReport')}
                    </button>
                  </div>
                )}
              </div>

              {/* Tax Notes */}
              <div className="bg-amber-50 rounded-xl p-4 mt-4 border border-amber-200">
                <div className="flex items-start gap-3">
                  <span className="text-amber-500 text-lg">⚠️</span>
                  <div>
                    <p className="text-sm font-medium text-amber-800">{t('adminFinance.taxNotes')}</p>
                    <ul className="text-xs text-amber-700 mt-1 list-disc list-inside space-y-0.5">
                      <li>Federal: ~15.3% Self-Employment tax + income tax bracket</li>
                      <li>California: ~9.3% marginal rate + LLC Annual Fee</li>
                      <li>Quarterly estimated tax payments due: Apr 15, Jun 15, Sep 15, Jan 15</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </Layout>
    </>
  );
}

// ═══════════════════════════════════════════════
// ─── Settings Panel ───
// ═══════════════════════════════════════════════

function SettingsPanel({
  settingsData,
  loadSettings,
  showToast,
  t: translate,
}: {
  settingsData: Record<string, unknown> | null;
  loadSettings: () => Promise<void>;
  showToast: (message: string, type: 'success' | 'error') => void;
  t: (key: string) => string;
}) {
  const t = translate;
  const [form, setForm] = useState({
    companyName: 'NELHEALTHCOACH, LLC',
    ein: '',
    registeredAgent: '',
    accountingMethod: 'cash',
    fiscalYearStart: '01-01',
    californiaLLC: { fileNumber: '', annualFee: 800, annualFeePaid: false },
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settingsData) {
      const llcData = (settingsData.californiaLLC as Record<string, unknown>) || {};
      setForm({
        companyName: (settingsData.companyName as string) || 'NELHEALTHCOACH, LLC',
        ein: (settingsData.hasEIN as boolean) ? '*****' : '',
        registeredAgent: (settingsData.registeredAgent as string) || '',
        accountingMethod: (settingsData.accountingMethod as string) || 'cash',
        fiscalYearStart: (settingsData.fiscalYearStart as string) || '01-01',
        californiaLLC: {
          fileNumber: (llcData.fileNumber as string) || '',
          annualFee: (llcData.annualFee as number) || 800,
          annualFeePaid: (llcData.annualFeePaid as boolean) || false,
        },
      });
    }
  }, [settingsData]);

  const handleSave = async () => {
    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        companyName: form.companyName,
        registeredAgent: form.registeredAgent,
        accountingMethod: form.accountingMethod,
        fiscalYearStart: form.fiscalYearStart,
        californiaLLC: {
          fileNumber: form.californiaLLC.fileNumber,
          annualFee: form.californiaLLC.annualFee,
          annualFeePaid: form.californiaLLC.annualFeePaid,
        },
      };
      if (form.ein && form.ein !== '*****') {
        payload.ein = form.ein;
      }
      const res = await apiClient.updateAdminFinanceSettings(payload);
      if (res.success) {
        showToast(t('adminFinance.settingsSaved'), 'success');
        loadSettings();
      }
    } catch (err) {
      showToast(translateApiError(err, t, 'common.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold text-gray-800 mb-4">⚙️ {t('adminFinance.settings')}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.companyName')}</label>
          <input type="text" value={form.companyName}
            onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.ein')}</label>
          <input type="text" placeholder="XX-XXXXXXX" value={form.ein}
            onChange={(e) => setForm(f => ({ ...f, ein: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.registeredAgent')}</label>
          <input type="text" value={form.registeredAgent}
            onChange={(e) => setForm(f => ({ ...f, registeredAgent: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.accountingMethod')}</label>
          <select value={form.accountingMethod}
            onChange={(e) => setForm(f => ({ ...f, accountingMethod: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500">
            <option value="cash">{t('adminFinance.cashBasis')}</option>
            <option value="accrual">{t('adminFinance.accrualBasis')}</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.fiscalYearStart')}</label>
          <input type="text" value={form.fiscalYearStart}
            onChange={(e) => setForm(f => ({ ...f, fiscalYearStart: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.caLLCFee')}</label>
          <input type="number" value={form.californiaLLC.annualFee}
            onChange={(e) => setForm(f => ({ ...f, californiaLLC: { ...f.californiaLLC, annualFee: parseInt(e.target.value, 10) } }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">{t('adminFinance.caLLCFileNumber')}</label>
          <input type="text" value={form.californiaLLC.fileNumber}
            onChange={(e) => setForm(f => ({ ...f, californiaLLC: { ...f.californiaLLC, fileNumber: e.target.value } }))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500" />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.californiaLLC.annualFeePaid}
              onChange={(e) => setForm(f => ({ ...f, californiaLLC: { ...f.californiaLLC, annualFeePaid: e.target.checked } }))}
              className="rounded text-purple-600 focus:ring-purple-500" />
            <span className="text-sm text-gray-600">CA LLC Annual Fee Paid</span>
          </label>
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition text-sm">
          {saving ? '...' : '💾 Save'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ─── Main Page ───
// ═══════════════════════════════════════════════

const FinancesPage = () => {
  const { t } = useTranslation();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setIsAdmin(payload.role === 'admin');
      } else {
        setIsAdmin(false);
      }
    } catch {
      setIsAdmin(false);
    }
  }, []);

  // Loading state while determining role
  if (isAdmin === null) {
    return (
      <>
        <Head><title>{t('finances.title')} - NELHEALTHCOACH</title></Head>
        <Layout>
          <div className="flex justify-center items-center min-h-[60vh]">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
          </div>
        </Layout>
      </>
    );
  }

  return isAdmin ? <AdminFinancesPage /> : <CoachFinancesPage />;
};

export default FinancesPage;
