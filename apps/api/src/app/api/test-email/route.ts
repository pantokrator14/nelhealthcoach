import { NextResponse } from 'next/server';
import { EmailService } from '@/app/lib/email-service';
import { apiHandler } from '@/app/lib/apiHandler';

async function getHandler() {
  // Solo accesible en desarrollo
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { success: false, message: 'No disponible en producción', code: 'FORBIDDEN'},
      { status: 403 }
    );
  }

  const emailService = EmailService.getInstance();
  const testResult = await emailService.sendEmail({
    to: ['tucorreo@gmail.com'],
    subject: '✅ Prueba de Resend desde NEL Health Coach',
    htmlBody: '<h1>Funciona!</h1><p>Si recibes esto, Resend está configurado.</p>',
    textBody: 'Funciona! Si recibes esto, Resend está configurado.'
  });
  
  return NextResponse.json({ success: testResult });
}

export const GET = apiHandler(getHandler);