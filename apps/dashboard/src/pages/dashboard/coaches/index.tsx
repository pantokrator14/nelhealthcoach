import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Layout from '../../../components/dashboard/Layout';
import Head from 'next/head';
import { apiClient } from '@/lib/api';
import { translateApiError } from '@/lib/apiErrorText';

import Image from 'next/image';
import { useToast } from '@/components/ui/Toast';

interface Coach {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  professionalTitle: string;
  profilePhoto?: { url: string } | null;
  role: string;
  emailVerified: boolean;
  isActive: boolean;
  isSuspended: boolean;
  trialStatus: string;
  subscriptionStatus: string;
  createdAt: string;
  clientCount: number;
  stripeConnect?: {
    hasAccount: boolean;
    onboardingComplete: boolean;
    payoutsEnabled: boolean;
  };
}

type SortField = 'createdAt' | 'firstName' | 'clientCount';
type StatusFilter = 'all' | 'active' | 'inactive' | 'suspended';
type StripeFilter = 'all' | 'connected' | 'not_connected';

export default function CoachesPage() {
  const { t } = useTranslation();
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCoach, setSelectedCoach] = useState<Coach | null>(null);
  const [deletingCoach, setDeletingCoach] = useState<string | null>(null);
  const { showToast, ToastComponent } = useToast();

  // Buscador y filtros
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [stripeFilter, setStripeFilter] = useState<StripeFilter>('all');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Debounce del buscador (300ms como en recetas)
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  }, []);

  // Datos filtrados y ordenados
  const filteredCoaches = useMemo(() => {
    let result = [...coaches];

    // Búsqueda por nombre, email, título
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((c) =>
        c.firstName.toLowerCase().includes(q) ||
        c.lastName.toLowerCase().includes(q) ||
        `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.professionalTitle || '').toLowerCase().includes(q)
      );
    }

    // Filtro por estado
    if (statusFilter === 'active') result = result.filter((c) => c.isActive && !c.isSuspended);
    else if (statusFilter === 'inactive') result = result.filter((c) => !c.isActive || c.isSuspended);
    else if (statusFilter === 'suspended') result = result.filter((c) => c.isSuspended);

    // Filtro por Stripe
    if (stripeFilter === 'connected') result = result.filter((c) => c.stripeConnect?.hasAccount);
    else if (stripeFilter === 'not_connected') result = result.filter((c) => !c.stripeConnect?.hasAccount);

    // Ordenar
    result.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'createdAt') cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      else if (sortField === 'firstName') cmp = a.firstName.localeCompare(b.firstName);
      else if (sortField === 'clientCount') cmp = a.clientCount - b.clientCount;
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    return result;
  }, [coaches, debouncedSearch, statusFilter, stripeFilter, sortField, sortOrder]);

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) + (stripeFilter !== 'all' ? 1 : 0);

  useEffect(() => {
    loadCoaches();
  }, []);

  const loadCoaches = async () => {
    try {
      setLoading(true);
      const res = await apiClient.getCoaches();
      if (res.success) {
        setCoaches(res.data || []);
      }
    } catch (err) {
      console.error('Error loading coaches:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCoach = async (coach: Coach, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingCoach) return;

    if (!window.confirm(t('coaches.deleteConfirm', { firstName: coach.firstName, lastName: coach.lastName, email: coach.email }))) {
      return;
    }

    try {
      setDeletingCoach(coach.id);
      await apiClient.deleteCoach(coach.id);
      setCoaches(prev => prev.filter(c => c.id !== coach.id));
      if (selectedCoach?.id === coach.id) {
        setSelectedCoach(null);
      }
      showToast(t('coaches.deleteSuccess', { firstName: coach.firstName, lastName: coach.lastName }), 'success');
    } catch (err) {
      showToast(translateApiError(err, t, 'coaches.deleteError'), 'error');
    } finally {
      setDeletingCoach(null);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-full" aria-label={t('coaches.loadingSpinnerLabel')}>
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500"></div>
        </div>
      </Layout>
    );
  }

  return (
    <>
      <Head>
        <title>{t('coaches.pageTitle')}</title>
      </Head>
      <Layout>
        <div className="p-8">
          {/* Encabezado */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between mb-6">
            <div className="flex items-center mb-4 lg:mb-0">
              <div className="w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-600 rounded-full flex items-center justify-center mr-4 shadow-md">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-3xl font-bold text-orange-700">{t('coaches.headerTitle')}</h1>
                <p className="text-orange-600 mt-1">{t('coaches.headerSubtitle')}</p>
              </div>
            </div>

            <div className="flex justify-end">
              <div className="bg-gradient-to-br from-orange-50 to-orange-100 rounded-xl p-4 border border-orange-200 shadow-sm min-w-[200px]">
                <div className="text-lg text-gray-700">
                  {t('coaches.totalLabel')} <span className="font-bold text-orange-600 text-xl">{coaches.length}</span>
                </div>
                {activeFilterCount > 0 && (
                  <div className="text-sm text-gray-400 mt-1">
                    {t('coaches.showing', { count: filteredCoaches.length })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Buscador + Filtros */}
          <div className="bg-white rounded-xl shadow-md border border-orange-100 p-4 mb-6">
            <div className="flex flex-col md:flex-row gap-4">
              {/* Barra de búsqueda */}
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder={t('coaches.searchPlaceholder')}
                  className="w-full pl-10 pr-10 py-2.5 text-gray-700 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 shadow-sm"
                />
                {search && (
                  <button onClick={() => handleSearchChange('')} className="absolute inset-y-0 right-0 pr-3 flex items-center hover:text-gray-600" aria-label={t('coaches.clearSearch')}>
                    <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Filtro estado */}
              <div className="flex gap-2 flex-wrap">
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className="px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 bg-white">
                  <option value="all">{t('coaches.filterAllStatuses')}</option>
                  <option value="active">{t('coaches.filterActive')}</option>
                  <option value="inactive">{t('coaches.filterInactive')}</option>
                  <option value="suspended">{t('coaches.filterSuspended')}</option>
                </select>

                {/* Filtro Stripe */}
                <select value={stripeFilter} onChange={(e) => setStripeFilter(e.target.value as StripeFilter)}
                  className="px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 bg-white">
                  <option value="all">{t('coaches.stripeAll')}</option>
                  <option value="connected">{t('coaches.stripeConnected')}</option>
                  <option value="not_connected">{t('coaches.stripeNotConnected')}</option>
                </select>

                {/* Ordenar */}
                <select value={sortField} onChange={(e) => setSortField(e.target.value as SortField)}
                  className="px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 bg-white">
                  <option value="createdAt">{t('coaches.sortCreatedAt')}</option>
                  <option value="firstName">{t('coaches.sortFirstName')}</option>
                  <option value="clientCount">{t('coaches.sortClientCount')}</option>
                </select>

                <button onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  className="px-3 py-2.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 bg-white flex items-center gap-1 text-gray-800">
                  <svg className={`w-4 h-4 transition-transform ${sortOrder === 'asc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  <span className="font-medium">{sortField === 'createdAt' ? t('coaches.sortOrderRecent') : sortField === 'firstName' ? t('coaches.sortOrderAZ') : t('coaches.sortOrderMost')}</span>
                </button>
              </div>
            </div>

            {/* Chips de filtros activos */}
            {activeFilterCount > 0 && (
              <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
                {statusFilter !== 'all' && (
                  <span className="inline-flex items-center gap-1 px-3 py-1 bg-orange-100 text-orange-700 rounded-full text-sm">
                    {statusFilter === 'active' ? t('coaches.chipActive') : statusFilter === 'inactive' ? t('coaches.chipInactive') : t('coaches.chipSuspended')}
                    <button onClick={() => setStatusFilter('all')} className="hover:text-orange-900">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </span>
                )}
                {stripeFilter !== 'all' && (
                  <span className="inline-flex items-center gap-1 px-3 py-1 bg-orange-100 text-orange-700 rounded-full text-sm">
                    {stripeFilter === 'connected' ? t('coaches.chipStripeConnected') : t('coaches.chipStripeNotConnected')}
                    <button onClick={() => setStripeFilter('all')} className="hover:text-orange-900">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </span>
                )}
                <button onClick={() => { setStatusFilter('all'); setStripeFilter('all'); }}
                  className="text-xs text-gray-500 hover:text-gray-700 underline">
                  {t('coaches.clearFilters')}
                </button>
              </div>
            )}
          </div>

          {/* Grid de coaches */}
          {filteredCoaches.length === 0 ? (
            <div className="text-center py-16 bg-gradient-to-br from-orange-50 to-yellow-50 rounded-2xl border border-orange-200">
              <div className="text-6xl mb-4">
                {coaches.length === 0 ? '👥' : '🔍'}
              </div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">
                {coaches.length === 0 ? t('coaches.emptyNoCoaches') : t('coaches.emptyNoResults')}
              </h3>
              <p className="text-gray-500">
                {coaches.length === 0
                  ? t('coaches.emptyNoCoachesDesc')
                  : t('coaches.emptyNoResultsDesc')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
              {filteredCoaches.map((coach) => (
                <div
                  key={coach.id}
                  onClick={() => setSelectedCoach(coach)}
                  className={`bg-white rounded-xl shadow-md border hover:shadow-lg transition-all cursor-pointer overflow-hidden relative group ${
                    coach.role === 'admin' ? 'border-orange-100 hover:border-orange-300' : 'border-blue-100 hover:border-blue-300'
                  }`}
                >
                  {/* Botón de eliminar — aparece al hover en la esquina superior derecha (solo para asesores, no admin) */}
                  {coach.role !== 'admin' && (
                    <button
                      onClick={(e) => handleDeleteCoach(coach, e)}
                      disabled={deletingCoach === coach.id}
                      className="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={t('coaches.deleteAriaLabel', { name: coach.firstName + ' ' + coach.lastName })}
                    >
                    {deletingCoach === coach.id ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </button>
                  )}
                  <div className={`p-6 flex justify-center ${
                    coach.role === 'admin' ? 'bg-gradient-to-br from-orange-400 to-orange-600' : 'bg-gradient-to-br from-blue-400 to-blue-600'
                  }`}>
                    <div className={`w-20 h-20 rounded-full border-4 border-white shadow-lg overflow-hidden flex items-center justify-center relative ${
                      coach.role === 'admin' ? 'bg-orange-300' : 'bg-blue-300'
                    }`}>
                      {coach.profilePhoto?.url ? (
                        <Image src={coach.profilePhoto.url} alt={coach.firstName} fill sizes="80px" className="object-cover" unoptimized />
                      ) : (
                        <span className="text-white text-3xl font-bold">{coach.firstName.charAt(0).toUpperCase()}</span>
                      )}
                    </div>
                  </div>
                  <div className="p-4 text-center">
                    <h3 className="font-semibold text-gray-800">{coach.firstName} {coach.lastName}</h3>
                    {coach.professionalTitle && (
                      <p className="text-xs text-gray-400 truncate mt-0.5">{coach.professionalTitle}</p>
                    )}
                    <p className="text-sm text-gray-500 truncate mt-1">{coach.email}</p>
                    <div className="flex items-center justify-center gap-1.5 mt-2 flex-wrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        coach.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                      }`}>
                        {coach.role === 'admin' ? t('coaches.roleAdmin') : t('coaches.roleCoach')}
                      </span>
                      {coach.role !== 'admin' && (
                        <>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            coach.stripeConnect?.onboardingComplete
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${coach.stripeConnect?.onboardingComplete ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                            {coach.stripeConnect?.onboardingComplete ? t('coaches.stripeStatusConnected') : t('coaches.stripeStatusNotConnected')}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            {coach.clientCount}
                          </span>
                        </>
                      )}
                    </div>
                    {/* Indicador de estado inactivo/suspendido */}
                    {(!coach.isActive || coach.isSuspended) && coach.role !== 'admin' && (
                      <div className="mt-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                          coach.isSuspended ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                        }`}>
                          {coach.isSuspended ? t('coaches.statusSuspended') : t('coaches.statusInactive')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Modal de detalle */}
        {selectedCoach && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4" onClick={() => setSelectedCoach(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className={`p-8 text-center ${
                selectedCoach.role === 'admin' ? 'bg-gradient-to-br from-orange-500 to-orange-700' : 'bg-gradient-to-br from-blue-500 to-blue-700'
              }`}>
                <div className={`w-24 h-24 rounded-full border-4 border-white shadow-lg mx-auto mb-4 overflow-hidden flex items-center justify-center relative ${
                  selectedCoach.role === 'admin' ? 'bg-orange-300' : 'bg-blue-300'
                }`}>
                  {selectedCoach.profilePhoto?.url ? (
                    <Image src={selectedCoach.profilePhoto.url} alt="" fill sizes="96px" className="object-cover" unoptimized />
                  ) : (
                    <span className="text-white text-4xl font-bold">{selectedCoach.firstName.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <h2 className="text-2xl font-bold text-white">{selectedCoach.firstName} {selectedCoach.lastName}</h2>
                {selectedCoach.professionalTitle && (
                  <p className={`text-sm mt-1 ${
                    selectedCoach.role === 'admin' ? 'text-orange-100' : 'text-blue-100'
                  }`}>{selectedCoach.professionalTitle}</p>
                )}
                <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${
                  selectedCoach.role === 'admin' ? 'bg-purple-200 text-purple-800' : 'bg-white text-blue-700'
                }`}>
                  {selectedCoach.role === 'admin' ? t('coaches.roleAdminModal') : t('coaches.roleCoachModal')}
                </span>
              </div>
              <div className="p-6 space-y-4">
                <div className="flex items-center">
                  <span className="text-lg mr-3">📧</span>
                  <div>
                    <p className="text-xs text-gray-400">{t('coaches.modalEmail')}</p>
                    <p className="text-gray-800">{selectedCoach.email}</p>
                  </div>
                </div>
                {selectedCoach.phone && (
                  <div className="flex items-center">
                    <span className="text-lg mr-3">📞</span>
                    <div>
                      <p className="text-xs text-gray-400">{t('coaches.modalPhone')}</p>
                      <p className="text-gray-800">{selectedCoach.phone}</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center">
                  <span className="text-lg mr-3">{selectedCoach.emailVerified ? '✅' : '⚠️'}</span>
                  <div>
                    <p className="text-xs text-gray-400">{t('coaches.modalVerification')}</p>
                    <p className="text-gray-800">{selectedCoach.emailVerified ? t('coaches.modalEmailVerified') : t('coaches.modalPending')}</p>
                  </div>
                </div>
                <div className="flex items-center">
                  <span className="text-lg mr-3">
                    {selectedCoach.isSuspended ? '⏸️' : selectedCoach.isActive ? '🟢' : '🔴'}
                  </span>
                  <div>
                    <p className="text-xs text-gray-400">{t('coaches.modalStatus')}</p>
                    <p className="text-gray-800">
                      {selectedCoach.isSuspended ? t('coaches.statusSuspended') : selectedCoach.isActive ? t('coaches.statusActive') : t('coaches.statusInactive')}
                    </p>
                  </div>
                </div>
                {selectedCoach.role !== 'admin' && (
                  <>
                    <div className="flex items-center">
                      <span className="text-lg mr-3">📅</span>
                      <div>
                        <p className="text-xs text-gray-400">{t('coaches.modalRegistered')}</p>
                        <p className="text-gray-800">{new Date(selectedCoach.createdAt).toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <span className="text-lg mr-3">👥</span>
                      <div>
                        <p className="text-xs text-gray-400">{t('coaches.modalClients')}</p>
                        <p className="text-gray-800 font-semibold">{t('coaches.modalClientCount', { count: selectedCoach.clientCount })}</p>
                      </div>
                    </div>
                    {/* Stripe Connect status */}
                    <div className="flex items-center">
                      {selectedCoach.stripeConnect?.onboardingComplete ? (
                        <>
                          <span className="text-lg mr-3">💳</span>
                          <div>
                            <p className="text-xs text-gray-400">{t('coaches.modalPaymentData')}</p>
                            <p className="text-gray-800">{t('coaches.modalStripeVerified')}</p>
                            {selectedCoach.stripeConnect.payoutsEnabled && (
                              <p className="text-xs text-emerald-600 font-medium">{t('coaches.modalPayoutsEnabled')}</p>
                            )}
                          </div>
                        </>
                      ) : selectedCoach.stripeConnect?.hasAccount ? (
                        <>
                          <span className="text-lg mr-3">💳</span>
                          <div>
                            <p className="text-xs text-gray-400">{t('coaches.modalPaymentData')}</p>
                            <p className="text-amber-600 font-medium">{t('coaches.modalStripeIncomplete')}</p>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-lg mr-3">💳</span>
                          <div>
                            <p className="text-xs text-gray-400">{t('coaches.modalPaymentData')}</p>
                            <p className="text-amber-600 font-medium">{t('coaches.modalStripeNotConnected')}</p>
                          </div>
                        </>
                      )}
                    </div>
                    {/* Suscripción / Trial */}
                    <div className="flex items-center">
                      <span className="text-lg mr-3">
                        {selectedCoach.subscriptionStatus === 'active' ? '✅' : selectedCoach.trialStatus === 'active' ? '🆓' : selectedCoach.trialStatus === 'expired' ? '⏰' : '—'}
                      </span>
                      <div>
                        <p className="text-xs text-gray-400">{t('coaches.modalSubscription')}</p>
                        <p className="text-gray-800">
                          {selectedCoach.subscriptionStatus === 'active' ? t('coaches.subscriptionActive') :
                           selectedCoach.trialStatus === 'active' ? t('coaches.subscriptionTrial') :
                           selectedCoach.trialStatus === 'expired' ? t('coaches.subscriptionExpired') :
                           selectedCoach.trialStatus === 'converted' ? t('coaches.subscriptionConverted') : t('coaches.subscriptionNone')}
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="px-6 pb-6">
                <button
                  onClick={() => setSelectedCoach(null)}
                  className="w-full py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition font-medium"
                >
                  {t('coaches.closeButton')}
                </button>
              </div>
            </div>
          </div>
        )}
        <ToastComponent />
      </Layout>
    </>
  );
}
