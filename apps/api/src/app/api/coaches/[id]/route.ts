// apps/api/src/app/api/coaches/[id]/route.ts
// CRUD individual de coach — DELETE exclusivo para admin

import { NextRequest, NextResponse } from 'next/server';
import Coach from '@/app/models/Coach';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { decrypt, isEncrypted } from '@/app/lib/encryption';
import { connectMongoose } from '@/app/lib/database';
import { apiHandler } from '@/app/lib/apiHandler';
import { S3Service } from '@/app/lib/s3';
import { logAuditEvent } from '@/app/lib/auditLogger';
import mongoose from 'mongoose';

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectMongoose();

    // Solo administradores
    let auth;
    try {
      auth = requireCoachAuth(request);
    } catch {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }

    if (auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, message: 'Solo administradores pueden eliminar coaches', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    const { id } = await params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, message: 'ID de coach inválido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Request context para audit logs
    const reqCtx = {
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
    };

    logger.info('COACHES', 'Solicitud DELETE /api/coaches/[id] recibida', { id });

    // Buscar coach antes de eliminar
    const coach = await Coach.findById(id);
    if (!coach) {
      return NextResponse.json(
        { success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    const coachEmail = coach.email ? decrypt(coach.email as string) : 'desconocido';
    const coachName = coach.firstName ? decrypt(coach.firstName as string) : '';

    // Proteger: no se puede eliminar al admin
    if (coach.role === 'admin') {
      return NextResponse.json(
        { success: false, message: 'No se puede eliminar una cuenta de administrador', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    // Eliminar foto de perfil de S3 si existe
    if (coach.profilePhoto) {
      const photo = coach.profilePhoto as Record<string, unknown>;
      if (photo.key) {
        try {
          let fileKey = String(photo.key);
          if (isEncrypted(fileKey)) {
            fileKey = decrypt(fileKey);
          }
          if (fileKey && fileKey.trim() !== '') {
            await S3Service.deleteFile(fileKey);
            logger.info('COACHES', 'Foto de perfil eliminada de S3', {
              coachId: id,
              fileKey: fileKey.substring(0, 30) + '...',
            });
          }
        } catch (s3Error) {
          logger.error('COACHES', 'Error eliminando foto de S3', s3Error as Error, { coachId: id });
        }
      }
    }

    // Eliminar de MongoDB
    await Coach.findByIdAndDelete(id);

    logger.info('COACHES', 'Coach eliminado exitosamente', {
      coachId: id,
      email: coachEmail,
    });

    logAuditEvent({
      eventType: 'ADMIN_ACTION',
      severity: 'info',
      message: `Admin eliminó al coach ${coachName} (${coachEmail})`,
      actorEmail: auth.email,
      actorRole: 'admin',
      ...reqCtx,
      path: '/api/coaches/[id]',
      method: 'DELETE',
      statusCode: 200,
      metadata: { deletedCoachId: id, deletedCoachEmail: coachEmail },
    });

    return NextResponse.json({
      success: true,
      message: 'Coach eliminado exitosamente',
    });
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('COACHES', 'Error eliminando coach', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const DELETE = apiHandler(deleteHandler);
