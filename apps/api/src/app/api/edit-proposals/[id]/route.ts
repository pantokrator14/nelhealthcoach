import { NextRequest, NextResponse } from 'next/server';
import EditProposal from '@/app/models/EditProposal';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { getRecipesCollection, getExerciseCollection, connectMongoose } from '@/app/lib/database';
import { ObjectId } from 'mongodb';
import { S3Service } from '@/app/lib/s3';
import { decrypt, isEncrypted } from '@/app/lib/encryption';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';
import { createNotification } from '@/app/lib/create-notification';

// PUT: Aprobar o rechazar propuesta (solo admin)
async function putHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);

    if (auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, message: 'Solo el administrador puede aprobar o rechazar propuestas', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    const { id } = await params;

    // Request context para audit logs
    const reqCtx = {
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
    };
    const body = await request.json();
    const { action, reviewNotes } = body; // action: 'approve' | 'reject'

    if (!action || !['approve', 'reject'].includes(action)) {
      return NextResponse.json(
        { success: false, message: 'action debe ser "approve" o "reject"', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const proposal = await EditProposal.findById(id);

    if (!proposal) {
      return NextResponse.json(
        { success: false, message: 'Propuesta no encontrada', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (proposal.status !== 'pending') {
      return NextResponse.json(
        { success: false, message: 'Esta propuesta ya fue procesada', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    if (action === 'approve') {
      proposal.reviewedBy = new ObjectId(auth.coachId);
      proposal.reviewedByName = auth.email;
      proposal.reviewNotes = reviewNotes || '';

      if (proposal.proposalType === 'creation') {
        // Propuesta de creación: solo publicar el item (isPublished → true)
        const update = { $set: { isPublished: true } };
        if (proposal.targetType === 'recipe') {
          const collection = await getRecipesCollection();
          await collection.updateOne(
            { _id: new ObjectId(proposal.targetId) },
            update
          );
        } else if (proposal.targetType === 'exercise') {
          const collection = await getExerciseCollection();
          await collection.updateOne(
            { _id: new ObjectId(proposal.targetId) },
            update
          );
        }
      } else {
        // Propuesta de edición: aplicar cambios (comportamiento actual)
        if (proposal.targetType === 'recipe') {
          const collection = await getRecipesCollection();
          await collection.updateOne(
            { _id: new ObjectId(proposal.targetId) },
            { $set: proposal.proposedChanges as Record<string, unknown> }
          );
        } else if (proposal.targetType === 'exercise') {
          const collection = await getExerciseCollection();
          await collection.updateOne(
            { _id: new ObjectId(proposal.targetId) },
            { $set: proposal.proposedChanges as Record<string, unknown> }
          );
        }
      }

      proposal.status = 'approved';
      await proposal.save();

      logger.info('OTHER', 'Propuesta aprobada', {
        proposalId: id,
        targetType: proposal.targetType,
        targetId: proposal.targetId.toString(),
        proposalType: proposal.proposalType,
      });

      // Notificar al creador de la propuesta
      try {
        const notifType = proposal.targetType === 'recipe' ? 'recipe_approved' : 'exercise_approved';
        const label = proposal.targetType === 'recipe' ? 'receta' : 'ejercicio';
        const authorLabel = proposal.proposalType === 'creation' ? 'publicado' : 'cambios aplicados';
        await createNotification({
          coachId: proposal.coachId?.toString() || proposal.createdBy?.toString() || auth.coachId,
          type: notifType,
          title: `✅ ${label.charAt(0).toUpperCase() + label.slice(1)} aprobado`,
          message: `Tu ${label} ha sido ${authorLabel} por el administrador.`,
          link: `/dashboard/${proposal.targetType === 'recipe' ? 'recipes' : 'exercises'}`,
        });
      } catch (notifError) {
        logger.warn('PROPOSAL', 'Error creando notificación de aprobación', notifError as Error);
      }

      logAuditEvent({
        eventType: 'ADMIN_ACTION',
        severity: 'info',
        message: `Propuesta ${proposal.proposalType === 'creation' ? 'de creación' : 'de edición'} aprobada: ${proposal.targetType} ${proposal.targetId.toString()}`,
        coachId: auth.coachId,
        ...reqCtx,
        path: `/api/edit-proposals/${id}`,
        method: 'PUT',
        statusCode: 200,
        metadata: { proposalId: id, targetType: proposal.targetType, targetId: proposal.targetId.toString(), action: 'approve' },
      });

      return NextResponse.json({
        success: true,
        message:
          proposal.proposalType === 'creation'
            ? 'Creación aprobada y publicada'
            : 'Propuesta aprobada y cambios aplicados',
      });
    }

    // ─── RECHAZAR: eliminar propuesta (y el item si es creación) ───
    if (action === 'reject') {
      // Si es propuesta de creación, eliminar también el item creado
      if (proposal.proposalType === 'creation') {
        try {
          if (proposal.targetType === 'exercise') {
            const collection = await getExerciseCollection();
            const item = await collection.findOne({ _id: new ObjectId(proposal.targetId) });
            if (item) {
              // Limpiar demo de S3 si existe
              if (item.demo?.key) {
                try {
                  let fileKey = item.demo.key;
                  if (typeof fileKey === 'string' && isEncrypted(fileKey)) {
                    fileKey = decrypt(fileKey);
                  }
                  if (fileKey) {
                    await S3Service.deleteFile(fileKey);
                  }
                } catch (s3Error) {
                  logger.warn('PROPOSAL', 'Error eliminando demo de S3 al rechazar creación', s3Error as Error);
                }
              }
              await collection.deleteOne({ _id: new ObjectId(proposal.targetId) });
            }
          } else if (proposal.targetType === 'recipe') {
            const collection = await getRecipesCollection();
            const item = await collection.findOne({ _id: new ObjectId(proposal.targetId) });
            if (item) {
              // Limpiar imagen de S3 si existe
              if (item.image?.key) {
                try {
                  let fileKey = item.image.key;
                  if (typeof fileKey === 'string' && isEncrypted(fileKey)) {
                    fileKey = decrypt(fileKey);
                  }
                  if (fileKey) {
                    await S3Service.deleteFile(fileKey);
                  }
                } catch (s3Error) {
                  logger.warn('PROPOSAL', 'Error eliminando imagen de S3 al rechazar creación', s3Error as Error);
                }
              }
              await collection.deleteOne({ _id: new ObjectId(proposal.targetId) });
            }
          }
        } catch (deleteError) {
          logger.error('PROPOSAL', 'Error eliminando item al rechazar creación', deleteError as Error);
          // Continuamos para al menos eliminar la propuesta
        }
      }

      // Eliminar la propuesta definitivamente
      await EditProposal.findByIdAndDelete(id);

      logger.info('OTHER', 'Propuesta rechazada y eliminada', {
        proposalId: id,
        targetType: proposal.targetType,
        proposalType: proposal.proposalType,
        targetId: proposal.targetId.toString(),
      });

      // Notificar al creador de la propuesta
      try {
        const notifType = proposal.targetType === 'recipe' ? 'recipe_rejected' : 'exercise_rejected';
        const label = proposal.targetType === 'recipe' ? 'receta' : 'ejercicio';
        const notes = reviewNotes ? ` Motivo: ${reviewNotes}` : '';
        await createNotification({
          coachId: proposal.coachId?.toString() || proposal.createdBy?.toString() || auth.coachId,
          type: notifType,
          title: `❌ ${label.charAt(0).toUpperCase() + label.slice(1)} rechazado`,
          message: `Tu ${label} ha sido rechazado por el administrador.${notes}`,
          link: `/dashboard/${proposal.targetType === 'recipe' ? 'recipes' : 'exercises'}`,
        });
      } catch (notifError) {
        logger.warn('PROPOSAL', 'Error creando notificación de rechazo', notifError as Error);
      }

      logAuditEvent({
        eventType: 'ADMIN_ACTION',
        severity: 'warning',
        message: `Propuesta ${proposal.proposalType === 'creation' ? 'de creación' : 'de edición'} rechazada: ${proposal.targetType} ${proposal.targetId.toString()}`,
        coachId: auth.coachId,
        ...reqCtx,
        path: `/api/edit-proposals/${id}`,
        method: 'PUT',
        statusCode: 200,
        metadata: { proposalId: id, targetType: proposal.targetType, targetId: proposal.targetId.toString(), action: 'reject' },
      });

      return NextResponse.json({
        success: true,
        message: 'Propuesta rechazada y eliminada',
      });
    }

    // No debería llegar aquí
    return NextResponse.json(
      { success: false, message: 'Acción no válida', code: 'VALIDATION'},
      { status: 400 }
    );
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }
    logger.error('OTHER', 'Error procesando propuesta', error);
    return NextResponse.json(
      { success: false, message: 'Error interno del servidor', code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const PUT = apiHandler(putHandler);
