// apps/api/src/app/api/notifications/route.ts
// Endpoints para listar notificaciones y marcar todas como leídas

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import Notification from '@/app/models/Notification';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * GET /api/notifications
 *
 * Lista las notificaciones del coach autenticado.
 * Query params: page (default 1), limit (default 20)
 */
async function getHandler(request: NextRequest) {
  try {
    await connectMongoose();

    let auth;
    try {
      auth = requireCoachAuth(request);
    } catch {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      Notification.find({ coachId: auth.coachId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ coachId: auth.coachId }),
    ]);

    return NextResponse.json({
      success: true,
      data: notifications,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('NOTIFICATIONS', 'Error listing notifications', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al cargar notificaciones',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);

/**
 * POST /api/notifications
 *
 * Marca todas las notificaciones del coach como leídas.
 * Body: { action: 'markAllRead' }
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();

    let auth;
    try {
      auth = requireCoachAuth(request);
    } catch {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    const body = await request.json();
    const { action } = body as { action?: string };

    if (action !== 'markAllRead') {
      return NextResponse.json(
        { success: false, message: 'Acción no válida', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    await Notification.updateMany(
      { coachId: auth.coachId, read: false },
      { $set: { read: true } }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('NOTIFICATIONS', 'Error marking all notifications as read', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al marcar notificaciones como leídas',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
