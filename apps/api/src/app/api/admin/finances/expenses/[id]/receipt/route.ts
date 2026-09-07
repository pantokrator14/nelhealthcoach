// apps/api/src/app/api/admin/finances/expenses/[id]/receipt/route.ts
// Receipt file upload for business expenses (admin only)
// POST  → Generate presigned upload URL
// PUT   → Confirm upload & save receipt reference
// DELETE → Delete receipt from S3 & DB

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import { S3Service } from '@/app/lib/s3';
import BusinessTransaction from '@/app/models/BusinessTransaction';

// ─── Auth: solo admin ───

function requireAdmin(request: NextRequest): void {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
}

// ─── POST: Generate presigned upload URL ───

async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAdmin(request);
    const { id } = await params;

    const body = (await request.json()) as {
      fileName: string;
      fileType: string;
      fileSize: number;
    };

    if (!body.fileName || !body.fileType || !body.fileSize) {
      return NextResponse.json(
        { success: false, message: 'fileName, fileType y fileSize son requeridos', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Validate file type (PDF, images only)
    const allowedTypes = [
      'application/pdf',
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    ];
    if (!allowedTypes.includes(body.fileType)) {
      return NextResponse.json(
        { success: false, message: 'Solo se permiten archivos PDF, JPG, PNG, GIF o WebP', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024;
    if (body.fileSize > maxSize) {
      return NextResponse.json(
        { success: false, message: 'El archivo es demasiado grande (máximo 10MB)', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Generate presigned URL — use 'document' category
    const { uploadURL, fileKey } = await S3Service.generateUploadURL(
      body.fileName,
      body.fileType,
      body.fileSize,
      'document'
    );

    logger.info('FINANCES', `URL de upload generada para recibo: ${id}`, {
      transactionId: id,
      fileName: body.fileName,
      s3Key: fileKey,
    });

    return NextResponse.json({
      success: true,
      data: {
        uploadURL,
        fileKey,
        fileURL: await S3Service.getFileURL(fileKey),
      },
    });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error generando URL de upload para recibo', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al generar URL de upload',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── PUT: Confirm upload & save receipt reference ───

async function putHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { id } = await params;

    const existing = await BusinessTransaction.findById(id);
    if (!existing) {
      return NextResponse.json(
        { success: false, message: 'Gasto no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (existing.source !== 'manual') {
      return NextResponse.json(
        { success: false, message: 'No se puede modificar una transacción automática', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const body = (await request.json()) as {
      s3Key: string;
      originalName: string;
      mimeType: string;
      size: number;
    };

    if (!body.s3Key) {
      return NextResponse.json(
        { success: false, message: 's3Key es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // Delete previous receipt if exists
    const prevReceipt = existing.receiptFile as { s3Key?: string } | null;
    if (prevReceipt?.s3Key && prevReceipt.s3Key !== body.s3Key) {
      try {
        await S3Service.deleteFile(prevReceipt.s3Key);
        logger.info('FINANCES', 'Recibo anterior eliminado de S3', {
          transactionId: id,
          oldKey: prevReceipt.s3Key,
        });
      } catch (s3Error) {
        logger.error('FINANCES', 'Error eliminando recibo anterior de S3', s3Error as Error, {
          transactionId: id,
          oldKey: prevReceipt.s3Key,
        });
        // Non-fatal — continue
      }
    }

    // Save receipt reference
    const receiptFile = {
      s3Key: body.s3Key,
      originalName: body.originalName,
      mimeType: body.mimeType,
      size: body.size,
      uploadedAt: new Date().toISOString(),
    };

    await BusinessTransaction.findByIdAndUpdate(id, {
      $set: { receiptFile },
    });

    logger.info('FINANCES', 'Recibo guardado exitosamente', {
      transactionId: id,
      originalName: body.originalName,
      s3Key: body.s3Key,
    });

    return NextResponse.json({
      success: true,
      message: 'Recibo guardado exitosamente',
      data: receiptFile,
    });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error guardando recibo', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al guardar el recibo',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── DELETE: Remove receipt from S3 & DB ───

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const { id } = await params;

    const existing = await BusinessTransaction.findById(id);
    if (!existing) {
      return NextResponse.json(
        { success: false, message: 'Gasto no encontrado', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    if (existing.source !== 'manual') {
      return NextResponse.json(
        { success: false, message: 'No se puede modificar una transacción automática', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const receiptFile = existing.receiptFile as { s3Key?: string } | null;

    if (!receiptFile?.s3Key) {
      return NextResponse.json(
        { success: false, message: 'Este gasto no tiene recibo', code: 'NOT_FOUND'},
        { status: 404 }
      );
    }

    // Delete from S3
    try {
      await S3Service.deleteFile(receiptFile.s3Key);
      logger.info('FINANCES', 'Recibo eliminado de S3', {
        transactionId: id,
        s3Key: receiptFile.s3Key,
      });
    } catch (s3Error) {
      logger.error('FINANCES', 'Error eliminando recibo de S3', s3Error as Error, {
        transactionId: id,
        s3Key: receiptFile.s3Key,
      });
      // Non-fatal — continue with DB cleanup
    }

    // Remove receipt reference from DB
    await BusinessTransaction.findByIdAndUpdate(id, {
      $unset: { receiptFile: '' },
    });

    logger.info('FINANCES', 'Recibo eliminado del gasto', { transactionId: id });

    return NextResponse.json({
      success: true,
      message: 'Recibo eliminado exitosamente',
    });
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError?.status) {
      return NextResponse.json(
        { success: false, message: apiError.message || 'Error' },
        { status: apiError.status }
      );
    }
    logger.error('FINANCES', 'Error eliminando recibo', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al eliminar el recibo',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
export const PUT = apiHandler(putHandler);
export const DELETE = apiHandler(deleteHandler);
