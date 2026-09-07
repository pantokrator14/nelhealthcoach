import { NextRequest, NextResponse } from 'next/server';
import { MongoClient, ObjectId } from 'mongodb';
import { getExerciseCollection, connectMongoose } from '@/app/lib/database';
import { logger } from '@/app/lib/logger';
import { encrypt, decrypt, safeDecrypt, isEncrypted } from '@/app/lib/encryption';
import { requireCoachAuth } from '@/app/lib/auth';
import { S3Service } from '@/app/lib/s3';
import { exerciseSchema } from '@/app/lib/schemas';
import EditProposal from '@/app/models/EditProposal';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';

// GET: Obtener ejercicios
async function getHandler(request: NextRequest) {
  return logger.time('EXERCISES', 'Obtener ejercicios', async () => {
    try {
      const searchParams = request.nextUrl.searchParams;
      const query = searchParams.get('search') || '';
      const mode = searchParams.get('mode') || 'full';

      // Determinar si el usuario es admin (para mostrar no publicados)
      let isAdmin = false;
      try {
        const auth = requireCoachAuth(request);
        isAdmin = auth.role === 'admin';
      } catch {
        // No autenticado: solo ver publicados
      }

      const collection = await getExerciseCollection();
      const filter: Record<string, unknown> = {};
      if (!isAdmin) {
        filter.isPublished = true;
      }
      const exercises = await collection.find(filter).toArray();

      const decryptedExercises = exercises.map((ex) => {
        const demoRaw = ex.demo as Record<string, unknown> | undefined;
        return {
          id: ex._id.toString(),
          name: safeDecrypt(ex.name),
          description: safeDecrypt(ex.description),
          category: ex.category.map((c: string) => safeDecrypt(c)),
          instructions: ex.instructions.map((i: string) => safeDecrypt(i)),
          equipment: ex.equipment.map((e: string) => safeDecrypt(e)),
          difficulty: safeDecrypt(ex.difficulty),
          clientLevel: safeDecrypt(ex.clientLevel),
          muscleGroups: ex.muscleGroups.map((m: string) => safeDecrypt(m)),
          contraindications: (ex.contraindications || []).map((c: string) => safeDecrypt(c)),
          sets: ex.sets,
          repetitions: safeDecrypt(ex.repetitions),
          timeUnderTension: safeDecrypt(ex.timeUnderTension),
          restBetweenSets: safeDecrypt(ex.restBetweenSets),
          progression: safeDecrypt(ex.progression),
          demo: demoRaw ? {
            url: safeDecrypt(demoRaw.url as string),
            key: safeDecrypt(demoRaw.key as string),
            type: safeDecrypt(demoRaw.type as string),
            name: safeDecrypt(demoRaw.name as string),
            size: demoRaw.size as number,
            uploadedAt: safeDecrypt(demoRaw.uploadedAt as string),
            videoSearchUrl: safeDecrypt((demoRaw.videoSearchUrl as string) ?? ''),
          } : null,
          progressionOf: ex.progressionOf ? ex.progressionOf.toString() : null,
          progressesTo: (ex.progressesTo || []).map((id: ObjectId) => id.toString()),
          author: ex.author ? safeDecrypt(ex.author) : 'NelHealthCoach',
          isPublished: ex.isPublished,
          tags: ex.tags.map((t: string) => safeDecrypt(t)),
          createdAt: ex.createdAt,
          updatedAt: ex.updatedAt,
        };
      });

      let results = decryptedExercises;

      if (query) {
        const searchLower = query.toLowerCase();
        results = decryptedExercises.filter((ex) =>
          ex.name.toLowerCase().includes(searchLower) ||
          ex.description.toLowerCase().includes(searchLower) ||
          ex.category.some((c: string) => c.toLowerCase().includes(searchLower)) ||
          ex.tags.some((t: string) => t.toLowerCase().includes(searchLower)) ||
          ex.muscleGroups.some((m: string) => m.toLowerCase().includes(searchLower))
        );
      }

      if (mode === 'search') {
        const searchResults = results.map((ex) => ({
          id: ex.id,
          name: ex.name,
          description: ex.description,
          demo: ex.demo,
          difficulty: ex.difficulty,
          clientLevel: ex.clientLevel,
        }));
        return NextResponse.json({ success: true, data: searchResults });
      }

      // Resolver nombres de progresiones (mapeo id → name)
      for (const ex of decryptedExercises) {
        if (ex.progressionOf) {
          const parent = decryptedExercises.find((e) => e.id === ex.progressionOf);
          (ex as Record<string, unknown>).progressionOfName = parent?.name || null;
        }
        if (ex.progressesTo && ex.progressesTo.length > 0) {
          (ex as Record<string, unknown>).progressesToNames = ex.progressesTo
            .map((id: string) => decryptedExercises.find((e) => e.id === id)?.name || null)
            .filter(Boolean);
        }
      }

      return NextResponse.json({ success: true, data: results });
    } catch (error: unknown) {
      logger.error('EXERCISES', 'Error al obtener ejercicios', error as Error);
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  });
}

export const GET = apiHandler(getHandler);

// POST: Crear ejercicio
async function postHandler(request: NextRequest) {
  return logger.time('EXERCISES', 'Crear ejercicio', async () => {
    try {
      const body = await request.json();

      // Request context para audit logs
      const reqCtx = {
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        requestId: request.headers.get('x-request-id') || undefined,
      };

      // Zod validation
      const parsed = exerciseSchema.safeParse(body);
      if (!parsed.success) {
        const firstError = parsed.error.issues[0];
        return NextResponse.json(
          {
            success: false,
            message: firstError?.message ?? 'Datos de ejercicio inválidos',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
            code: 'VALIDATION',
          },
          { status: 400 },
        );
      }

      const validData = parsed.data;
      const collection = await getExerciseCollection();

      // Obtener info del coach para el campo author (autenticación requerida)
      const auth = requireCoachAuth(request);
      const authorName = auth.email || 'NelHealthCoach';
      const isAdmin = auth.role === 'admin';

      // Si no es admin, la creación necesita aprobación
      const isPublished = isAdmin ? (body.isPublished ?? true) : false;

      const exerciseDoc = {
        name: encrypt(validData.name),
        description: encrypt(validData.description),
        category: validData.category.map((c: string) => encrypt(c)),
        instructions: validData.instructions.map((i: string) => encrypt(i)),
        equipment: validData.equipment.map((e: string) => encrypt(e)),
        difficulty: encrypt(validData.difficulty),
        clientLevel: encrypt(validData.clientLevel),
        muscleGroups: validData.muscleGroups.map((m: string) => encrypt(m)),
        contraindications: (validData.contraindications || []).map((c: string) => encrypt(c)),
        sets: validData.sets,
        repetitions: encrypt(validData.repetitions),
        timeUnderTension: encrypt(validData.timeUnderTension),
        restBetweenSets: encrypt(validData.restBetweenSets),
        progression: encrypt(validData.progression),
        demo: validData.demo ? {
          url: encrypt(validData.demo.url),
          key: encrypt(validData.demo.key),
          type: encrypt(validData.demo.type),
          name: encrypt(validData.demo.name),
          size: validData.demo.size,
          uploadedAt: encrypt(validData.demo.uploadedAt),
          videoSearchUrl: validData.demo.videoSearchUrl ? encrypt(validData.demo.videoSearchUrl) : '',
        } : null,
        progressionOf: validData.progressionOf ? new ObjectId(validData.progressionOf) : null,
        progressesTo: (validData.progressesTo || []).map((id: string) => new ObjectId(id)),
        author: encrypt(validData.author || authorName),
        isPublished,
        tags: validData.tags.map((t: string) => encrypt(t)),
      };

      const result = await collection.insertOne(exerciseDoc);

      // Si no es admin, crear propuesta de creación para moderación
      if (!isAdmin) {
        await connectMongoose();
        await EditProposal.create({
          targetType: 'exercise',
          targetId: new ObjectId(result.insertedId.toString()),
          proposalType: 'creation',
          proposedChanges: {},
          proposedBy: new ObjectId(auth.coachId),
          proposedByName: auth.email,
          status: 'pending',
        });

        logger.info('EXERCISES', 'Ejercicio creado pendiente de aprobación', {
          exerciseId: result.insertedId.toString(),
          coachId: auth.coachId,
        });

        logAuditEvent({
          eventType: 'EXERCISE_CREATED',
          severity: 'info',
          message: `Ejercicio creado: ${body.name}`,
          coachId: auth.coachId,
          ...reqCtx,
          path: '/api/exercises',
          method: 'POST',
          statusCode: 201,
        });

        return NextResponse.json({
          success: true,
          message: 'Tu ejercicio ha sido enviado para revisión del administrador',
          data: {
            id: result.insertedId.toString(),
            pendingApproval: true,
          },
        });
      }

      logAuditEvent({
        eventType: 'EXERCISE_CREATED',
        severity: 'info',
        message: `Ejercicio creado: ${body.name}`,
        coachId: auth.coachId,
        ...reqCtx,
        path: '/api/exercises',
        method: 'POST',
        statusCode: 201,
      });

      return NextResponse.json({
        success: true,
        data: { id: result.insertedId.toString() },
      });
    } catch (error: unknown) {
      const apiError = error as { status?: number; message?: string };
      // Si es un error estructurado (auth), devolver su status específico
      if (apiError?.status) {
        return NextResponse.json(
          { 
            success: false, 
            message: apiError.message || 'Error',
            ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message })
          },
          { status: apiError.status }
        );
      }
      logger.error('EXERCISES', 'Error al crear ejercicio', error as Error);
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  });
}

export const POST = apiHandler(postHandler);

// PUT: Actualizar ejercicio
async function putHandler(request: NextRequest) {
  return logger.time('EXERCISES', 'Actualizar ejercicio', async () => {
    try {
      const body = await request.json();
      const { id, ...updateData } = body;

      if (!id) {
        return NextResponse.json(
          { success: false, message: 'ID requerido', code: 'VALIDATION'},
          { status: 400 }
        );
      }

      const collection = await getExerciseCollection();

      const encryptedUpdate: Record<string, unknown> = {};
      if (updateData.name !== undefined) encryptedUpdate.name = encrypt(updateData.name);
      if (updateData.description !== undefined) encryptedUpdate.description = encrypt(updateData.description);
      if (updateData.category !== undefined) encryptedUpdate.category = updateData.category.map((c: string) => encrypt(c));
      if (updateData.instructions !== undefined) encryptedUpdate.instructions = updateData.instructions.map((i: string) => encrypt(i));
      if (updateData.equipment !== undefined) encryptedUpdate.equipment = updateData.equipment.map((e: string) => encrypt(e));
      if (updateData.difficulty !== undefined) encryptedUpdate.difficulty = encrypt(updateData.difficulty);
      if (updateData.clientLevel !== undefined) encryptedUpdate.clientLevel = encrypt(updateData.clientLevel);
      if (updateData.muscleGroups !== undefined) encryptedUpdate.muscleGroups = updateData.muscleGroups.map((m: string) => encrypt(m));
      if (updateData.contraindications !== undefined) encryptedUpdate.contraindications = updateData.contraindications.map((c: string) => encrypt(c));
      if (updateData.sets !== undefined) encryptedUpdate.sets = updateData.sets;
      if (updateData.repetitions !== undefined) encryptedUpdate.repetitions = encrypt(updateData.repetitions);
      if (updateData.timeUnderTension !== undefined) encryptedUpdate.timeUnderTension = encrypt(updateData.timeUnderTension);
      if (updateData.restBetweenSets !== undefined) encryptedUpdate.restBetweenSets = encrypt(updateData.restBetweenSets);
      if (updateData.progression !== undefined) encryptedUpdate.progression = encrypt(updateData.progression);
      if (updateData.demo !== undefined) {
        encryptedUpdate.demo = updateData.demo ? {
          url: encrypt(updateData.demo.url),
          key: encrypt(updateData.demo.key),
          type: encrypt(updateData.demo.type),
          name: encrypt(updateData.demo.name),
          size: updateData.demo.size,
          uploadedAt: encrypt(updateData.demo.uploadedAt),
          videoSearchUrl: updateData.demo.videoSearchUrl ? encrypt(updateData.demo.videoSearchUrl) : '',
        } : null;
      }
      if (updateData.progressionOf !== undefined) encryptedUpdate.progressionOf = updateData.progressionOf ? new ObjectId(updateData.progressionOf) : null;
      if (updateData.progressesTo !== undefined) encryptedUpdate.progressesTo = updateData.progressesTo.map((id: string) => new ObjectId(id));
      if (updateData.isPublished !== undefined) encryptedUpdate.isPublished = updateData.isPublished;
      if (updateData.tags !== undefined) encryptedUpdate.tags = updateData.tags.map((t: string) => encrypt(t));

      encryptedUpdate.updatedAt = new Date();

      // Verificar rol: Admin actualiza directo, Coach crea propuesta
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
        // Coach no-admin: crear propuesta
        await connectMongoose();
        const proposal = await EditProposal.create({
          targetType: 'exercise',
          targetId: new ObjectId(id),
          proposedChanges: encryptedUpdate,
          proposedBy: new ObjectId(auth.coachId),
          proposedByName: auth.email,
          status: 'pending',
        });

        logger.info('EXERCISES', 'Propuesta de edición creada', {
          exerciseId: id,
          proposalId: proposal._id.toString(),
          coachId: auth.coachId,
        });

        return NextResponse.json({
          success: true,
          message: 'Tu propuesta de edición ha sido enviada para revisión del administrador',
          data: {
            pendingApproval: true,
            proposalId: proposal._id.toString(),
          },
        });
      }

      // Admin: actualizar directamente
      const result = await collection.updateOne(
        { _id: new ObjectId(id) },
        { $set: encryptedUpdate }
      );

      if (result.matchedCount === 0) {
        return NextResponse.json(
          { success: false, message: 'Ejercicio no encontrado', code: 'NOT_FOUND'},
          { status: 404 }
        );
      }

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      logger.error('EXERCISES', 'Error al actualizar ejercicio', error as Error);
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  });
}

export const PUT = apiHandler(putHandler);

// DELETE: Eliminar ejercicios (solo admin)
async function deleteHandler(request: NextRequest) {
  return logger.time('EXERCISES', 'Eliminar ejercicios', async () => {
    try {
      // Solo administradores pueden eliminar ejercicios
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
          { success: false, message: 'Solo administradores pueden eliminar ejercicios', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }

      const body = await request.json();
      const { ids } = body as { ids: string[] };

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return NextResponse.json(
          { success: false, message: 'IDs requeridos', code: 'VALIDATION'},
          { status: 400 }
        );
      }

      const collection = await getExerciseCollection();

      // Obtener los ejercicios antes de eliminarlos para limpiar S3
      const exercisesToDelete = await collection.find({
        _id: { $in: ids.map((id: string) => new ObjectId(id)) },
      }).toArray();

      const result = await collection.deleteMany({
        _id: { $in: ids.map((id: string) => new ObjectId(id)) },
      });

      // Eliminar demos de S3
      for (const exercise of exercisesToDelete) {
        if (exercise.demo?.key) {
          try {
            let fileKey = exercise.demo.key;
            // Desencriptar si está encriptada (v2 o legacy)
            if (typeof fileKey === 'string' && isEncrypted(fileKey)) {
              try {
                fileKey = decrypt(fileKey);
              } catch {
                // Usar original si falla
              }
            }
            if (fileKey) {
              await S3Service.deleteFile(fileKey);
              logger.info('EXERCISES', 'Demo eliminado de S3 durante borrado de ejercicio', {
                exerciseId: exercise._id.toString(),
                fileKey: fileKey.substring(0, 30) + '...',
              });
            }
          } catch (s3Error) {
            logger.error('EXERCISES', 'Error eliminando demo de S3 durante borrado de ejercicio', s3Error as Error, {
              exerciseId: exercise._id.toString(),
            });
            // No fallar la operación principal
          }
        }
      }

      return NextResponse.json({
        success: true,
        data: { deletedCount: result.deletedCount },
      });
    } catch (error: unknown) {
      logger.error('EXERCISES', 'Error al eliminar ejercicios', error as Error);
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  });
}

export const DELETE = apiHandler(deleteHandler);
