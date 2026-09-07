import { NextRequest, NextResponse } from 'next/server';
import Coach from '@/app/models/Coach';
import { logger } from '@/app/lib/logger';
import { connectMongoose } from '@/app/lib/database';
import { hashToken } from '@/app/lib/tokenHash';
import { apiHandler } from '@/app/lib/apiHandler';

async function getHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const searchParams = request.nextUrl.searchParams;
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json(
        { success: false, message: 'Token de verificación requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    // SEC-15: el token en DB está hasheado (sha256); se compara el hash.
    // Fallback legacy: tokens guardados en texto plano antes de SEC-15.
    const tokenHash = hashToken(token);
    let coach = await Coach.findOne({ verificationToken: tokenHash });
    if (!coach) {
      coach = await Coach.findOne({ verificationToken: token });
    }

    if (!coach) {
      // Token no encontrado: ya fue usado, fue reemplazado por reenvío, o es inválido.
      // No se hace una búsqueda genérica de "cualquier coach verificado" porque
      // eso podría confirmar falsamente la verificación de OTRO coach (bug de seguridad).
      // El flujo correcto es pedir un reenvío del enlace.
      return NextResponse.json(
        {
          success: false,
          message: 'El enlace de verificación es inválido o ha expirado. Solicita un nuevo enlace desde la pantalla de inicio de sesión.',
          needsResend: true,
          code: 'VALIDATION',
        },
        { status: 400 }
      );
    }

    // Si el coach ya está verificado (por alguna razón aún tiene token), igual responder éxito
    if (coach.emailVerified) {
      coach.verificationToken = null;
      await coach.save();

      return NextResponse.json({
        success: true,
        message: 'Tu email ya estaba verificado. Puedes iniciar sesión.',
      });
    }

    // Verificar ahora
    coach.emailVerified = true;
    coach.verificationToken = null;
    await coach.save();

    logger.info('AUTH', 'Email verificado exitosamente', {
      coachId: coach._id.toString(),
    });

    return NextResponse.json({
      success: true,
      message: 'Email verificado exitosamente. Ya puedes iniciar sesión.',
    });
  } catch (error: unknown) {
    logger.error('AUTH', 'Error verificando email', error instanceof Error ? error : new Error(String(error)));
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
