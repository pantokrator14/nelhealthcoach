import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { encrypt, decrypt } from '@/app/lib/encryption';
import { connectMongoose } from '@/app/lib/database';
import Coach from '@/app/models/Coach';
import { S3Service } from '@/app/lib/s3';
import { apiHandler } from '@/app/lib/apiHandler';

// POST: Generar URL firmada para subir foto de perfil
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);
    const body = await request.json();
    const { fileName, fileType, fileSize } = body;

    if (!fileName || !fileType || !fileSize) {
      return NextResponse.json(
        { success: false, message: 'fileName, fileType y fileSize son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const { uploadURL, fileKey } = await S3Service.generateUploadURL(
      fileName,
      fileType,
      fileSize,
      'profile'
    );

    const fileURL = await S3Service.getFileURL(fileKey);

    return NextResponse.json({
      success: true,
      data: { uploadURL, fileKey, fileURL },
    });
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('OTHER', 'Error generando URL de upload', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'}, 
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);

// PUT: Confirmar upload y guardar en perfil del coach
async function putHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);
    const body = await request.json();
    const { fileKey, fileName, fileType, fileSize, fileURL } = body;

    if (!fileKey) {
      return NextResponse.json(
        { success: false, message: 'fileKey requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const coach = await Coach.findById(auth.coachId);
    if (!coach) {
      return NextResponse.json({ success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'}, { status: 404 });
    }

    // Eliminar foto anterior de S3 si existe
    if (coach.profilePhoto?.key) {
      try {
        const oldKey = decrypt(coach.profilePhoto.key);
        if (oldKey && oldKey.trim() !== '') {
          await S3Service.deleteFile(oldKey);
          logger.info('OTHER', 'Foto anterior eliminada de S3', { coachId: auth.coachId, oldKey });
        }
      } catch (deleteError) {
        logger.error('OTHER', 'Error eliminando foto anterior de S3', deleteError instanceof Error ? deleteError : new Error(String(deleteError)));
      }
    }

    coach.profilePhoto = {
      url: encrypt(fileURL || ''),
      key: encrypt(fileKey),
      name: encrypt(fileName || ''),
      type: encrypt(fileType || ''),
      size: fileSize || 0,
      uploadedAt: new Date().toISOString(),
    };

    await coach.save();

    return NextResponse.json({
      success: true,
      message: 'Foto de perfil actualizada',
      data: {
        profilePhoto: {
          url: fileURL,
          key: fileKey,
          name: fileName,
          type: fileType,
          size: fileSize,
          uploadedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('OTHER', 'Error confirmando upload', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'}, 
      { status: 500 }
    );
  }
}

export const PUT = apiHandler(putHandler);
