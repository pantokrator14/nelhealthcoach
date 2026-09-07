import { NextRequest, NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';
import { logger } from '@/app/lib/logger';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';

async function getHandler(request: NextRequest) {
  try {
    requireCoachAuth(request);
  } catch {
    return NextResponse.json(
      { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
      { status: 401 }
    );
  }
  let client: MongoClient | null = null;
  
  try {
    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI no está definida');
    }
    
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    
    const dbName = new URL(MONGODB_URI).pathname.substring(1);
    const db = client.db(dbName);
    const collection = db.collection('recipes');
    
    // Obtener estadísticas agregadas
    const stats = await collection.aggregate([
      {
        $match: { isPublished: true }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          avgCookTime: { $avg: '$cookTime' },
          avgCalories: { $avg: '$nutrition.calories' },
          avgProtein: { $avg: '$nutrition.protein' },
          avgCarbs: { $avg: '$nutrition.carbs' },
          avgFat: { $avg: '$nutrition.fat' },
          categories: { $addToSet: '$category' },
          difficulties: { $addToSet: '$difficulty' }
        }
      },
      {
        $project: {
          _id: 0,
          total: 1,
          avgCookTime: { $round: ['$avgCookTime', 0] },
          avgCalories: { $round: ['$avgCalories', 0] },
          avgProtein: { $round: ['$avgProtein', 1] },
          avgCarbs: { $round: ['$avgCarbs', 1] },
          avgFat: { $round: ['$avgFat', 1] },
          categoryCount: { $size: { $reduce: {
            input: '$categories',
            initialValue: [],
            in: { $setUnion: ['$$value', '$$this'] }
          }}},
          difficultyDistribution: '$difficulties'
        }
      }
    ]).toArray();
    
    // Obtener recetas por categoría
    const byCategory = await collection.aggregate([
      { $match: { isPublished: true } },
      { $unwind: '$category' },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          avgCalories: { $avg: '$nutrition.calories' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();
    
    // Obtener recetas por dificultad
    const byDifficulty = await collection.aggregate([
      { $match: { isPublished: true } },
      {
        $group: {
          _id: '$difficulty',
          count: { $sum: 1 },
          avgCookTime: { $avg: '$cookTime' }
        }
      }
    ]).toArray();
    
    return NextResponse.json({
      success: true,
      data: {
        overall: stats[0] || {},
        byCategory,
        byDifficulty,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error: any) {
    console.error('Error getting recipe stats:', error.message);
    logger.error('RECIPES', 'Error obteniendo estadísticas de recetas', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error obteniendo estadísticas',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  } finally {
    if (client) await client.close();
  }
}

export const GET = apiHandler(getHandler);