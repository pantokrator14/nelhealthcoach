import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { NutritionService } from '@/app/lib/nutrition-service';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';

async function postHandler(request: NextRequest) {
  return logger.time('NUTRITION_ANALYSIS', 'Analizando nutrición de ingredientes', async () => {
    try {
      // Autenticación requerida (solo coaches)
      requireCoachAuth(request);

      const body = await request.json();
      const { ingredients, servings, recipeId } = body;
      
      if (!ingredients || !Array.isArray(ingredients)) {
        return NextResponse.json(
          { success: false, message: 'Se requiere un array de ingredientes', code: 'VALIDATION'},
          { status: 400 }
        );
      }
      
      logger.info('NUTRITION_ANALYSIS', 'Solicitud de análisis nutricional', {
        ingredientCount: ingredients.length,
        servings: servings || 1,
        recipeId
      });
      
      // Usar IA para análisis
      const nutritionData = await NutritionService.analyzeIngredientsWithAI({
        ingredients,
        servings: servings || 1,
        recipeId
      });
      
      return NextResponse.json({
        success: true,
        data: nutritionData,
        source: 'ai_analysis',
        timestamp: new Date().toISOString()
      });
      
    } catch (error: any) {
      // Si es un error estructurado (auth), devolver su status específico
      if (error?.status) {
        return NextResponse.json(
          { 
            success: false, 
            message: 'Error de autenticación',
            ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message })
          },
          { status: error.status }
        );
      }

      logger.error('NUTRITION_ANALYSIS', 'Error analizando nutrición', error);
      
      // Intentar cálculo local como fallback
      try {
        const { ingredients, servings = 1 } = await request.json();
        const nutritionData = await NutritionService.calculateNutritionLocally(
          ingredients,
          servings
        );
        
        return NextResponse.json({
          success: true,
          data: nutritionData,
          source: 'local_fallback',
          warning: 'Usando cálculo local (IA no disponible)',
          timestamp: new Date().toISOString()
        });
        
      } catch (fallbackError) {
        return NextResponse.json(
          { 
            success: false, 
            message: 'Error analizando nutrición',
            ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
          { status: 500 }
        );
      }
    }
  });
}

export const POST = apiHandler(postHandler);