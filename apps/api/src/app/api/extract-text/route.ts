// apps/api/src/app/api/extract-text/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { extractTextFromBuffer } from '@/app/lib/document-extractor';
import type { ExtractionResult } from '@/app/lib/document-extractor';
import { logger } from '@/app/lib/logger';

// Tipos de archivo permitidos (MIME)
const ALLOWED_MIME_TYPES = [
  'text/plain',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/pdf',
  'application/msword', // .doc (limitado)
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

// Tamaño máximo de archivo (10MB - las imágenes pueden ser más grandes que PDFs)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

async function postHandler(request: NextRequest) {
  const logCtx = logger.withContext({ endpoint: 'extract-text' });

  try {
    // Autenticación requerida (solo coaches)
    requireCoachAuth(request);

    // Obtener el FormData de la solicitud
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { success: false, message: 'No se proporcionó ningún archivo', code: 'VALIDATION'},
        { status: 400 },
      );
    }

    // Validar tamaño
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          success: false,
          message: `El archivo es demasiado grande (máximo ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
          code: 'VALIDATION',
        },
        { status: 400 },
      );
    }

    // Validar tipo de archivo
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      const allowed = ALLOWED_MIME_TYPES.join(', ');
      return NextResponse.json(
        {
          success: false,
          message: `Tipo de archivo no soportado: "${file.type}". Permitidos: ${allowed}`,
          code: 'VALIDATION',
        },
        { status: 400 },
      );
    }

    logCtx.info('AI', 'Extrayendo texto', {
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    });

    // Convertir File a Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extraer texto usando el nuevo extractor local
    const extracted: ExtractionResult = await extractTextFromBuffer(
      buffer,
      file.name,
      file.type,
    );

    if (!extracted.text.trim()) {
      return NextResponse.json({
        success: true,
        data: {
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          extractedText: 'No se pudo extraer texto del archivo. Puede estar vacío, dañado, o ser un PDF escaneado sin capa de texto.',
          extractedLength: 0,
          extractionMethod: extracted.method,
          pages: extracted.pages,
        },
      });
    }

    logCtx.info('AI', 'Texto extraído exitosamente', {
      method: extracted.method,
      chars: extracted.text.length,
      pages: extracted.pages,
      ocrConfidence: extracted.ocrConfidence,
    });

    return NextResponse.json({
      success: true,
      data: {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        extractedText: extracted.text,
        extractedLength: extracted.text.length,
        extractionMethod: extracted.method,
        pages: extracted.pages,
        ocrConfidence: extracted.ocrConfidence,
      },
    });
  } catch (error: unknown) {
    // Si es un error estructurado (auth), devolver su status específico
    if (error instanceof Error && 'status' in error) {
      const authError = error as Error & { status: number };
      if (authError.status) {
        return NextResponse.json(
          {
            success: false,
            message: authError.message,
            ...(process.env.NODE_ENV === 'development' && { detail: authError.message }),
          },
          { status: authError.status },
        );
      }
    }

    const message = error instanceof Error ? error.message : 'Error desconocido';
    logger.error('AI', 'Error en extract-text endpoint', error instanceof Error ? error : undefined, {
      error: message.substring(0, 300),
    });

    return NextResponse.json(
      {
        success: false,
        message: 'Error extrayendo texto del archivo',
        ...(process.env.NODE_ENV === 'development' && { detail: message }),
        code: 'INTERNAL',
      },
      { status: 500 },
    );
  }
}

export const POST = apiHandler(postHandler);

// Método OPTIONS para CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
