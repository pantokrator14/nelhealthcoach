import { NextRequest, NextResponse } from 'next/server';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';

async function getHandler(request: NextRequest) {
  try {
    const auth = requireCoachAuth(request);
    const formUrl = process.env.FORM_URL || 'http://localhost:3002';

    // Leer el tipo de link: 'paid' (default) o 'free'
    const type = request.nextUrl.searchParams.get('type') || 'paid';

    // Solo administradores pueden generar enlaces gratuitos
    if (type === 'free' && auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, message: 'Solo administradores pueden generar enlaces gratuitos', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    let link: string;
    if (type === 'free') {
      link = `${formUrl}?coach=${auth.coachId}&free=1`;
    } else {
      link = `${formUrl}?coach=${auth.coachId}`;
    }

    logger.info('OTHER', 'Enlace de registro generado', {
      coachId: auth.coachId,
      type,
    });

    return NextResponse.json({
      success: true,
      data: {
        link,
        coachId: auth.coachId,
        type,
      },
    });
    } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }
    logger.error('OTHER', 'Error generando enlace', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);
