import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import Coach, { emailHashVariants } from '@/app/models/Coach';
import { EmailService } from '@/app/lib/email-service';
import { logger } from '@/app/lib/logger';
import { decrypt } from '@/app/lib/encryption';
import { hashToken } from '@/app/lib/tokenHash';
import { connectMongoose } from '@/app/lib/database';
import { apiHandler } from '@/app/lib/apiHandler';
import { generateVerificationEmailHTML } from '@/app/lib/email-templates';

/**
 * POST /api/auth/resend-verification
 *
 * Reenvía el enlace de verificación al email del coach.
 * Siempre genera un token NUEVO (el anterior queda invalidado): el token
 * almacenado en DB es solo el hash (SEC-15), no es recuperable, y rotar el
 * token en cada reenvío es la práctica segura.
 */
async function postHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json(
        { success: false, message: 'Email es requerido', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const emailLower = email.toLowerCase().trim();
    // Búsqueda dual: v2 HMAC + legacy sha256 (cuentas pre-SEC-10)
    const coach = await Coach.findOne({ emailHash: { $in: emailHashVariants(emailLower) } });

    // Por seguridad, siempre retornamos éxito aunque el coach no exista
    // o ya esté verificado, para no revelar información.
    if (!coach || coach.emailVerified) {
      return NextResponse.json({
        success: true,
        message: 'Si el email existe y no está verificado, recibirás un enlace.',
      });
    }

    // SEC-15: generar token nuevo y guardar solo su hash
    const verificationToken = crypto.randomBytes(32).toString('hex');
    coach.verificationToken = hashToken(verificationToken);
    await coach.save();

    // Obtener nombre del coach para personalizar el email
    let coachName = 'Coach';
    try {
      if (coach.firstName) {
        coachName = decrypt(coach.firstName as string);
      }
    } catch {
      coachName = 'Coach';
    }

    // Construir URL de verificación
    const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const verifyUrl = `${appUrl}/verify-email?token=${verificationToken}`;

    // Enviar email con la plantilla moderna
    const emailService = EmailService.getInstance();
    await emailService.sendEmail({
      to: [emailLower],
      subject: 'NELHealthCoach - Verifica tu email',
      htmlBody: generateVerificationEmailHTML({
        coachName,
        verifyUrl,
      }),
    }).catch((err) => {
      logger.warn('AUTH', 'Error enviando email de verificación', err);
    });

    logger.info('AUTH', 'Enlace de verificación reenviado', {
      email: coach.email,
      tokenRotated: true,
    });

    return NextResponse.json({
      success: true,
      message: 'Enlace de verificación reenviado.',
    });
  } catch (error: unknown) {
    logger.error('AUTH', 'Error en resend-verification', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);
