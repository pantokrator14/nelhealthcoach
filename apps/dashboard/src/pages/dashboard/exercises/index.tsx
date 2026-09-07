import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Layout from '../../../components/dashboard/Layout';
import Head from 'next/head';
import ExerciseCard from '../../../components/dashboard/ExerciseCard';
import ExerciseModal from '../../../components/dashboard/ExerciseModal';
import ExerciseDetailModal from '../../../components/dashboard/ExerciseDetailModal';
import ExerciseFilters, { ExerciseFilterState } from '../../../components/dashboard/ExerciseFilters';
import { useToast } from '../../../components/ui/Toast';
import { apiClient, Exercise } from '../../../lib/api';
import { translateApiError } from '@/lib/apiErrorText';

import { useTranslation } from 'react-i18next';

interface Proposal {
  id: string;
  targetId: { toString(): string };
  proposedByName?: string;
  createdAt: string;
}

const ExercisesPage = () => {
  const { t } = useTranslation();
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedExercise, setSelectedExercise] = useState<Exercise | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [stats, setStats] = useState({
    total: 0,
    easy: 0,
    medium: 0,
    hard: 0,
  });

  // Pestañas pendientes
  const [activeTab, setActiveTab] = useState<'all' | 'pending'>('all');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalCount, setProposalCount] = useState(0);

  // Estado para eliminación múltiple
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedExercises, setSelectedExercises] = useState<string[]>([]);

  const [filters, setFilters] = useState<ExerciseFilterState>({
    search: '',
    category: [],
    difficulty: [],
    clientLevel: [],
    muscleGroup: [],
    equipment: [],
    sortBy: 'createdAt',
    sortOrder: 'desc',
  });

  const { showToast, ToastComponent } = useToast();

  const loadExercises = useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiClient.getExercises();

      if (response.success) {
        setExercises(response.data);

        const statsData = {
          total: response.data.length,
          easy: response.data.filter(e => e.difficulty === 'easy').length,
          medium: response.data.filter(e => e.difficulty === 'medium').length,
          hard: response.data.filter(e => e.difficulty === 'hard').length,
        };
        setStats(statsData);
      } else {
        console.error('Error loading exercises:', response.message);
        showToast(t('exercises.errorLoading'), 'error');
      }
    } catch (err: unknown) {
      console.error('Error loading exercises:', err);
      showToast(t('exercises.errorLoading'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadExercises();
  }, [loadExercises]);

  // Cargar propuestas pendientes
  const loadProposals = useCallback(async () => {
    try {
      setProposalsLoading(true);
      const res = await apiClient.getEditProposals({ targetType: 'exercise', status: 'pending' });
      if (res.success) {
        setProposals(res.data || []);
        setProposalCount((res.data || []).length);
      }
    } catch (err) {
      console.error('Error loading proposals:', err);
    } finally {
      setProposalsLoading(false);
    }
  }, []);

  // Cargar según pestaña
  useEffect(() => {
    if (activeTab === 'pending') {
      loadProposals();
    } else {
      loadExercises();
    }
  }, [activeTab, loadExercises, loadProposals]);

  const handleApproveProposal = async (proposalId: string) => {
    try {
      await apiClient.approveProposal(proposalId);
      showToast(t('exercises.proposalApproved'), 'success');
      loadProposals();
      loadExercises();
    } catch (err: unknown) {
      showToast(translateApiError(err, t, 'exercises.errorApproving'), 'error');
    }
  };

  const handleRejectProposal = async (proposalId: string) => {
    try {
      await apiClient.rejectProposal(proposalId, 'Rechazada por el administrador');
      showToast(t('exercises.proposalRejected'), 'success');
      loadProposals();
    } catch (err: unknown) {
      showToast(translateApiError(err, t, 'exercises.errorRejecting'), 'error');
    }
  };

  // Obtener categorías y tags existentes para sugerencias
  const existingCategories = useMemo(() => {
    return Array.from(new Set(exercises.flatMap(ex => ex.category))).sort();
  }, [exercises]);

  const existingTags = useMemo(() => {
    return Array.from(new Set(exercises.flatMap(ex => ex.tags))).sort();
  }, [exercises]);

  // Filtrar y ordenar ejercicios
  const filteredAndSortedExercises = useMemo(() => {
    let result = [...exercises];

    // Aplicar filtros
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      result = result.filter(exercise =>
        exercise.name.toLowerCase().includes(searchLower) ||
        exercise.description.toLowerCase().includes(searchLower) ||
        exercise.category.some(cat => cat.toLowerCase().includes(searchLower)) ||
        exercise.tags.some(tag => tag.toLowerCase().includes(searchLower)) ||
        exercise.muscleGroups.some(mg => mg.toLowerCase().includes(searchLower)) ||
        exercise.equipment.some(eq => eq.toLowerCase().includes(searchLower))
      );
    }

    if (filters.category.length > 0) {
      result = result.filter(exercise =>
        filters.category.some(cat => exercise.category.includes(cat))
      );
    }

    if (filters.difficulty.length > 0) {
      result = result.filter(exercise =>
        filters.difficulty.includes(exercise.difficulty)
      );
    }

    if (filters.clientLevel.length > 0) {
      result = result.filter(exercise =>
        filters.clientLevel.includes(exercise.clientLevel)
      );
    }

    if (filters.muscleGroup.length > 0) {
      result = result.filter(exercise =>
        filters.muscleGroup.some(mg => exercise.muscleGroups.includes(mg))
      );
    }

    if (filters.equipment.length > 0) {
      result = result.filter(exercise =>
        filters.equipment.some(eq => exercise.equipment.includes(eq))
      );
    }

    // Ordenar
    result.sort((a, b) => {
      let comparison = 0;
      switch (filters.sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'difficulty':
          const diffOrder = { easy: 1, medium: 2, hard: 3 };
          comparison = (diffOrder[a.difficulty] || 0) - (diffOrder[b.difficulty] || 0);
          break;
        case 'clientLevel':
          const levelOrder = { principiante: 1, intermedio: 2, avanzado: 3 };
          comparison = (levelOrder[a.clientLevel] || 0) - (levelOrder[b.clientLevel] || 0);
          break;
        case 'sets':
          comparison = a.sets - b.sets;
          break;
        case 'muscleGroupCount':
          comparison = a.muscleGroups.length - b.muscleGroups.length;
          break;
        default: // createdAt
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return filters.sortOrder === 'desc' ? -comparison : comparison;
    });

    return result;
  }, [exercises, filters]);

  const handleResetFilters = useCallback(() => {
    setFilters({
      search: '',
      category: [],
      difficulty: [],
      clientLevel: [],
      muscleGroup: [],
      equipment: [],
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  }, []);

  // Handlers de eliminación
  const toggleDeleteMode = useCallback(() => {
    if (deleteMode) {
      setSelectedExercises([]);
    }
    setDeleteMode(prev => !prev);
  }, [deleteMode]);

  const toggleExerciseSelection = useCallback((id: string) => {
    setSelectedExercises(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  const handleDeleteMultipleExercises = useCallback(async () => {
    if (selectedExercises.length === 0) return;
    try {
      const response = await apiClient.deleteExercises(selectedExercises);
      if (response.success) {
        showToast(t('exercises.deletedMultiple', { count: response.data.deletedCount.toString() }), 'success');
        setSelectedExercises([]);
        setDeleteMode(false);
        loadExercises();
      }
    } catch (err: unknown) {
      showToast(translateApiError(err, t, 'exercises.errorDeleting'), 'error');
    }
  }, [selectedExercises, showToast, loadExercises]);

  // Handlers de card click
  const handleCardClick = useCallback((exercise: Exercise) => {
    if (deleteMode) return;
    setSelectedExercise(exercise);
    setIsDetailModalOpen(true);
  }, [deleteMode]);

  const hasPrevious = useMemo(() => {
    if (!selectedExercise) return false;
    const idx = filteredAndSortedExercises.findIndex(e => e.id === selectedExercise.id);
    return idx > 0;
  }, [selectedExercise, filteredAndSortedExercises]);

  const hasNext = useMemo(() => {
    if (!selectedExercise) return false;
    const idx = filteredAndSortedExercises.findIndex(e => e.id === selectedExercise.id);
    return idx < filteredAndSortedExercises.length - 1;
  }, [selectedExercise, filteredAndSortedExercises]);

  const handlePrevious = useCallback(() => {
    if (!selectedExercise) return;
    const idx = filteredAndSortedExercises.findIndex(e => e.id === selectedExercise.id);
    if (idx > 0) {
      setSelectedExercise(filteredAndSortedExercises[idx - 1]);
    }
  }, [selectedExercise, filteredAndSortedExercises]);

  const handleNext = useCallback(() => {
    if (!selectedExercise) return;
    const idx = filteredAndSortedExercises.findIndex(e => e.id === selectedExercise.id);
    if (idx < filteredAndSortedExercises.length - 1) {
      setSelectedExercise(filteredAndSortedExercises[idx + 1]);
    }
  }, [selectedExercise, filteredAndSortedExercises]);

  // Handlers de editar/eliminar desde modal
  const handleEditExercise = useCallback((exercise: Exercise) => {
    setIsDetailModalOpen(false);
    setSelectedExercise(exercise);
    setIsEditModalOpen(true);
  }, []);

  const handleDeleteExercise = useCallback(async (exercise: Exercise) => {
    try {
      await apiClient.deleteExercises([exercise.id]);
      showToast(t('exercises.deleted'), 'success');
      setIsDetailModalOpen(false);
      setSelectedExercise(null);
      loadExercises();
    } catch {
      showToast(t('exercises.errorDeleting'), 'error');
    }
  }, [showToast, loadExercises]);

  // Crear ejercicio
  const handleCreateExercise = useCallback(() => {
    setSelectedExercise(null);
    setIsEditModalOpen(true);
  }, []);

  // onSuccess del modal de edición/creación
  const handleExerciseSuccess = useCallback((exercise?: Exercise) => {
    loadExercises();
    setIsEditModalOpen(false);
    setSelectedExercise(null);
  }, [loadExercises]);

  if (loading) {
    return (
      <Layout>
        <div className="p-8">
          <div className="flex flex-col items-center justify-center h-96">
            <div className="relative">
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-teal-500"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-8 h-8 bg-teal-100 rounded-full"></div>
              </div>
            </div>
            <p className="mt-6 text-lg text-gray-700 font-medium">{t('exercises.loadingText')}</p>
            <p className="text-gray-500">{t('exercises.loadingWait')}</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <>
      <Head>
        <title>{t('exercises.title') + ' - NELHEALTHCOACH'}</title>
        <meta name="description" content={t('exercises.pageDescription')} />
      </Head>
      <Layout>
        <div className="p-8">
          {/* Encabezado */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between mb-8">
            <div className="flex items-center mb-4 lg:mb-0">
              <div className="w-12 h-12 bg-gradient-to-br from-teal-500 to-teal-600 rounded-full flex items-center justify-center mr-4 shadow-md">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h1 className="text-3xl font-bold text-teal-700">
                  {t('exercises.title')}
                </h1>
                <p className="text-teal-600 mt-1">{t('exercises.headerSubtitle')}</p>
              </div>
            </div>

            {/* Estadísticas */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4 border border-blue-200 shadow-sm">
                <div className="text-lg text-gray-700">
                  {t('exercises.statTotal')} <span className="font-bold text-blue-700 text-xl">{stats.total}</span>
                </div>
              </div>
              <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-4 border border-green-200 shadow-sm">
                <div className="text-lg text-gray-700">
                  {t('exercises.statEasy')} <span className="font-bold text-green-700 text-xl">{stats.easy}</span>
                </div>
              </div>
              <div className="bg-gradient-to-br from-yellow-50 to-yellow-100 rounded-xl p-4 border border-yellow-200 shadow-sm">
                <div className="text-lg text-gray-700">
                  {t('exercises.statMedium')} <span className="font-bold text-yellow-700 text-xl">{stats.medium}</span>
                </div>
              </div>
              <div className="bg-gradient-to-br from-red-50 to-red-100 rounded-xl p-4 border border-red-200 shadow-sm">
                <div className="text-lg text-gray-700">
                  {t('exercises.statComplex')} <span className="font-bold text-red-700 text-xl">{stats.hard}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Pestañas: Todas / Pendientes */}
          <div className="mb-6 border-b border-gray-200">
            <nav className="flex space-x-4">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition ${
                  activeTab === 'all'
                    ? 'border-teal-600 text-teal-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {t('exercises.tabAll')}
              </button>
              <button
                onClick={() => setActiveTab('pending')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition relative ${
                  activeTab === 'pending'
                    ? 'border-orange-500 text-orange-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {t('exercises.tabPending')}
                {proposalCount > 0 && (
                  <span className="ml-2 bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full">
                    {proposalCount}
                  </span>
                )}
              </button>
            </nav>
          </div>

          {/* Contenido según pestaña */}
          {activeTab === 'pending' ? (
            <div>
              {proposalsLoading ? (
                <div className="flex justify-center py-16">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500"></div>
                </div>
              ) : proposals.length === 0 ? (
                <div className="text-center py-16 bg-gray-50 rounded-2xl border border-gray-200">
                  <div className="text-4xl mb-4">✅</div>
                  <h3 className="text-xl font-semibold text-gray-700 mb-2">{t('exercises.noPendingProposals')}</h3>
                  <p className="text-gray-500">{t('exercises.noPendingProposalsDesc')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {proposals.map((proposal) => (
                    <div key={proposal.id} className="bg-white rounded-xl shadow border border-orange-200 overflow-hidden">
                      <div className="bg-orange-50 px-4 py-3 border-b border-orange-200 flex justify-between items-center">
                        <div>
                          <span className="inline-block bg-orange-100 text-orange-700 text-xs px-2 py-0.5 rounded-full font-medium mr-2">
                            {t('exercises.proposalStatus')}
                          </span>
                          <span className="text-sm text-gray-600">
                            {t('exercises.proposedBy', { name: proposal.proposedByName || 'Coach' })}
                          </span>
                        </div>
                        <span className="text-xs text-gray-400">
                          {new Date(proposal.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="p-4">
                        <p className="text-sm text-gray-500 mb-3">{t('exercises.changesInExerciseId', { id: proposal.targetId?.toString().substring(0, 8) })}</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleApproveProposal(proposal.id)}
                            className="flex-1 bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700 transition font-medium"
                          >
                            {t('exercises.approve')}
                          </button>
                          <button
                            onClick={() => handleRejectProposal(proposal.id)}
                            className="flex-1 bg-red-500 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-red-600 transition font-medium"
                          >
                            {t('exercises.reject')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
          {/* Filtros */}
          <ExerciseFilters
            exercises={exercises}
            activeFilters={filters}
            onFilterChange={setFilters}
            onReset={handleResetFilters}
          />

          {/* Botones de acciones */}
          <div className="mb-6 flex flex-col sm:flex-row sm:justify-between items-stretch sm:items-center gap-3">
            <div className="w-full sm:w-auto">
              {deleteMode ? (
                <button
                  onClick={toggleDeleteMode}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-gray-600 to-gray-700 text-white rounded-lg hover:from-gray-700 hover:to-gray-800 transition-all transform hover:scale-105 shadow-md font-medium"
                  aria-label={t('exercises.cancelDeleteMode')}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  {t('exercises.cancelDeleteMode')}
                </button>
              ) : (
                <button
                  onClick={toggleDeleteMode}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-red-600 to-red-700 text-white rounded-lg hover:from-red-700 hover:to-red-800 transition-all transform hover:scale-105 shadow-md font-medium"
                  aria-label={t('exercises.deleteModeActivateAriaLabel')}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  {t('exercises.deleteMultiple')}
                </button>
              )}
            </div>
            <button
              onClick={handleCreateExercise}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-teal-600 to-teal-700 text-white rounded-lg hover:from-teal-700 hover:to-teal-800 transition-all transform hover:scale-105 shadow-md font-medium"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('exercises.createNewExercise')}
            </button>
          </div>

          {/* Banner de modo eliminación */}
          {deleteMode && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center">
                <svg className="w-5 h-5 text-red-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.998-.833-2.768 0L4.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <p className="text-red-700 font-medium">
                  {t('exercises.deleteModeBanner')}
                  <span className="font-normal text-red-600 ml-1">{t('exercises.deleteModeHint')}</span>
                </p>
              </div>
            </div>
          )}

          {/* Resultados de búsqueda */}
          <div className="mb-4 flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">
              {filteredAndSortedExercises.length === exercises.length
                ? t('exercises.showingAll', { count: filteredAndSortedExercises.length })
                : t('exercises.showingFiltered', { count: filteredAndSortedExercises.length, total: exercises.length })
              }
            </h3>

            {filteredAndSortedExercises.length > 0 && (
              <div className="text-sm text-teal-700 bg-gray-100 px-3 py-1 rounded-full">
                {t('exercises.sortLabel')} {
                  filters.sortBy === 'name' ? t('exercises.sortByName') :
                  filters.sortBy === 'difficulty' ? t('exercises.sortByDifficulty') :
                  filters.sortBy === 'clientLevel' ? t('exercises.sortByLevel') :
                  filters.sortBy === 'sets' ? t('exercises.sortBySets') :
                  filters.sortBy === 'muscleGroupCount' ? t('exercises.sortByMuscleGroups') :
                  t('exercises.sortByDate')
                } ({filters.sortOrder === 'asc' ? t('exercises.sortAsc') : t('exercises.sortDesc')})
              </div>
            )}
          </div>

          {/* Grid de ejercicios */}
          {filteredAndSortedExercises.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
              {filteredAndSortedExercises.map((exercise) => (
                <ExerciseCard
                  key={exercise.id}
                  exercise={exercise}
                  deleteMode={deleteMode}
                  isSelected={selectedExercises.includes(exercise.id)}
                  onToggleSelect={toggleExerciseSelection}
                  onClick={() => handleCardClick(exercise)}
                />
              ))}
            </div>
          ) : exercises.length > 0 ? (
            <div className="text-center py-16 bg-gradient-to-br from-gray-50 to-gray-100 rounded-2xl border border-gray-200">
              <div className="text-gray-400 text-6xl mb-6">🔍</div>
              <h3 className="text-2xl font-semibold text-gray-800 mb-3">{t('exercises.emptyFilteredTitle')}</h3>
              <p className="text-gray-600 mb-8 max-w-md mx-auto">
                {t('exercises.emptyFilteredDesc')}
                {' '}Intenta ajustar tus criterios de búsqueda.
              </p>
              <button
                onClick={handleResetFilters}
                className="px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition font-medium"
              >
                {t('exercises.emptyFilteredAction')}
              </button>
            </div>
          ) : (
            <div className="text-center py-16 bg-gradient-to-br from-teal-50 to-cyan-50 rounded-2xl border border-teal-200">
              <div className="text-teal-400 text-7xl mb-6">⚡</div>
              <h3 className="text-2xl font-semibold text-gray-800 mb-3">{t('exercises.emptyAllTitle')}</h3>
              <p className="text-gray-600 mb-8 max-w-md mx-auto">{t('exercises.emptyAllDesc')}</p>
              <button
                onClick={handleCreateExercise}
                className="px-8 py-3.5 bg-gradient-to-r from-teal-600 to-teal-700 text-white rounded-lg hover:from-teal-700 hover:to-teal-800 transition font-medium shadow-lg"
              >
                <span className="flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {t('exercises.emptyAllAction')}
                </span>
              </button>
            </div>
          )}

        </>
          )}

          {/* Botón flotante para eliminar seleccionados */}
        {deleteMode && selectedExercises.length > 0 && (
          <div className="fixed bottom-6 right-6 z-50">
            <button
              onClick={handleDeleteMultipleExercises}
              className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-red-600 to-red-700 text-white rounded-lg hover:from-red-700 hover:to-red-800 transition-all transform hover:scale-105 shadow-lg font-medium animate-bounce"
              aria-label={t('exercises.deleteSelectedAriaLabel', { count: selectedExercises.length })}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {t('exercises.deleteSelectedCount', { count: selectedExercises.length })}
            </button>
          </div>
        )}

        </div>

        {/* Modal de detalle */}
        {isDetailModalOpen && selectedExercise && (
          <ExerciseDetailModal
            exercise={selectedExercise}
            onClose={() => {
              setIsDetailModalOpen(false);
              setSelectedExercise(null);
            }}
            onEdit={() => handleEditExercise(selectedExercise)}
            onDelete={() => handleDeleteExercise(selectedExercise)}
            onPrevious={() => { if (hasPrevious) handlePrevious(); }}
            onNext={() => { if (hasNext) handleNext(); }}
            hasPrevious={hasPrevious}
            hasNext={hasNext}
            onSelectExercise={(exerciseId) => {
              const found = exercises.find(e => e.id === exerciseId);
              if (found) {
                setSelectedExercise(found);
                setIsDetailModalOpen(true);
              }
            }}
          />
        )}

        {/* Modal de creación/edición */}
        {isEditModalOpen && (
          <ExerciseModal
            exercise={selectedExercise}
            onClose={() => {
              setIsEditModalOpen(false);
              setSelectedExercise(null);
            }}
            onSuccess={handleExerciseSuccess}
            existingCategories={existingCategories}
            existingTags={existingTags}
            allExercises={exercises}
          />
        )}

        {/* Toast Notifications */}
        <ToastComponent />
      </Layout>
    </>
  );
};

export default ExercisesPage;
