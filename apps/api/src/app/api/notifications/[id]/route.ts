// apps/api/src/app/api/notifications/[id]/route.ts
// Endpoint para marcar una notificación como leída

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import Notification from '@/app/models/Notification';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * PATCH /api/notifications/[id]
 *
 * Marca una notificación como leída.
 */
async function patchHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    const { id } = await params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, coachId: auth.coachId },
      { $set: { read: true } },
      { new: true }
    );

    if (!notification) {
      return NextResponse.json(
        { success: false, message: 'Notificación no encontrada', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('NOTIFICATIONS', 'Error marking notification as read', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al marcar notificación como leída',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const PATCH = apiHandler(patchHandler);
