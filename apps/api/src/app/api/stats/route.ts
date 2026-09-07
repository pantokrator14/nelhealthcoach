import { NextRequest, NextResponse } from 'next/server';
import { getHealthFormsCollection, getRecipesCollection, getExerciseCollection } from '../../lib/database';
import { requireCoachAuth } from '../../lib/auth';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';
import { connectMongoose } from '@/app/lib/database';

async function getHandler(request: NextRequest) {
  try {
    const auth = requireCoachAuth(request);
    const isAdmin = auth.role === 'admin';

    const healthForms = await getHealthFormsCollection();
    const recipes = await getRecipesCollection();
    const exercises = await getExerciseCollection();

    // Filtro por coach si no es admin
    const clientFilter: Record<string, unknown> = {};
    if (!isAdmin) {
      clientFilter.coachId = auth.coachId;
    }

    // ── Clientes ──
    const clientCount = await healthForms.countDocuments(clientFilter);

    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const recentClients = await healthForms.countDocuments({
      ...clientFilter,
      submissionDate: { $gte: last30Days },
    });

    // ── Recetas ──
    const recipeCount = await recipes.countDocuments();

    // ── Ejercicios ──
    const exerciseCount = await exercises.countDocuments();

    // ── Propuestas pendientes (solo admin, o todas si es coach) ──
    let pendingProposals = 0;
    try {
      await connectMongoose();
      const { default: EditProposal } = await import('@/app/models/EditProposal');
      const proposalFilter: Record<string, unknown> = { status: 'pending' };
      if (!isAdmin) {
        proposalFilter.coachId = auth.coachId;
      }
      pendingProposals = await EditProposal.countDocuments(proposalFilter);
    } catch {
      // Si falla la conexión a Mongoose, devolvemos 0
    }

    return NextResponse.json({
      success: true,
      data: {
        clientCount,
        recipeCount,
        exerciseCount,
        recentClients,
        pendingProposals,
      },
    });
  } catch (error: any) {
    console.error('❌ Error fetching stats:', error);
    logger.error('API', 'Error obteniendo estadísticas', error);

    if (error.message?.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);
