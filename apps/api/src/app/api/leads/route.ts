// apps/api/src/app/api/leads/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getLeadsCollection } from '@/app/lib/database';
import { secureRoute } from '@/app/lib/security/index';
import { leadSchema } from '@/app/lib/schemas';
import { Resend } from 'resend';
import { logger } from '@/app/lib/logger';
import { apiHandler } from '@/app/lib/apiHandler';
import fs from 'fs';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);

// Validar variables de entorno necesarias
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
const CONTACT_PHONE_ES = process.env.CONTACT_PHONE_ES;
const CONTACT_PHONE_EN = process.env.CONTACT_PHONE_EN;
const CONTACT_ADDRESS = process.env.CONTACT_ADDRESS;

// Leer el logo y convertirlo a base64 para incrustarlo
let LOGO_BLUE_BASE64 = '';
try {
  const logoPath = path.join(process.cwd(), 'public', 'images', 'logo-blue.png');
  const logoBuffer = fs.readFileSync(logoPath);
  LOGO_BLUE_BASE64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
  logger.info('LEAD', 'Logo cargado correctamente en base64');
} catch (error) {
  logger.error('LEAD', 'Error al cargar el logo en base64, se usará placeholder', error);
  // Fallback a un placeholder o URL externa
  LOGO_BLUE_BASE64 = 'https://via.placeholder.com/200x100?text=NELHealthCoach';
}

// Verificar que CONTACT_EMAIL esté definido (es necesario para enviar al coach)
if (!CONTACT_EMAIL) {
  logger.error('LEAD', 'CONTACT_EMAIL no está definido en las variables de entorno');
}

async function postHandler(request: NextRequest) {
  logger.info('LEAD', 'Recibida solicitud POST');
  try {
    const body = await request.json();
    logger.info('LEAD', 'Body recibido', body);

    // Verificación de seguridad: rate limit + shield body scan
    const securityCheck = await secureRoute(request, body);
    if (!securityCheck.passed) {
      return NextResponse.json(
        { success: false, message: securityCheck.message ?? 'Solicitud bloqueada por seguridad' },
        {
          status: securityCheck.statusCode ?? 429,
          ...(securityCheck.retryAfter && { headers: { 'Retry-After': String(securityCheck.retryAfter) } }),
        }
      );
    }

    // Zod validation
    const parsed = leadSchema.safeParse(body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return NextResponse.json(
        {
          success: false,
          message: firstError?.message ?? 'Datos inválidos',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
          code: 'VALIDATION',
        },
        { status: 400 },
      );
    }

    const { name, email, phone, objective } = parsed.data;

    // Guardar en base de datos
    logger.info('LEAD', 'Intentando conectar a MongoDB...');
    const leadsCollection = await getLeadsCollection();
    logger.info('LEAD', 'Conexión exitosa, insertando documento...');
    await leadsCollection.insertOne({
      name,
      email,
      phone,
      objective,
      createdAt: new Date(),
    });
    logger.info('LEAD', 'Documento insertado correctamente');

    // Plantilla base para ambos correos (con logo incrustado)
    const baseHtml = (content: string) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            margin: 0;
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #f5f5f5;
          }
          .email-container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          }
          .header {
            text-align: center;
            padding: 30px 20px 20px;
          }
          .logo {
            max-width: 200px;
            height: auto;
            display: block;
            margin: 0 auto;
          }
          .content {
            padding: 20px 30px 30px;
            color: #4a5568; /* text-gray-700 */
          }
          h1 {
            color: #2b6cb0; /* text-blue-700 */
            font-size: 24px;
            margin: 0 0 10px;
          }
          h2 {
            color: #2b6cb0;
            font-size: 18px;
            margin: 20px 0 10px;
          }
          .highlight {
            color: #2b6cb0;
            font-weight: 600;
          }
          .data-block {
            background: #f7fafc;
            border-radius: 8px;
            padding: 15px;
            margin: 15px 0;
            border-left: 4px solid #2b6cb0;
          }
          .data-row {
            margin: 8px 0;
          }
          .data-label {
            font-weight: 600;
            color: #2b6cb0;
            width: 100px;
            display: inline-block;
          }
          .data-value {
            color: #4a5568;
          }
          .footer {
            background: #2d3748; /* gray-800 */
            color: #e2e8f0;
            padding: 25px 30px;
            text-align: center;
            font-size: 14px;
          }
          .footer a {
            color: #90cdf4;
            text-decoration: none;
          }
          .footer a:hover {
            text-decoration: underline;
          }
          .contact-info {
            margin-top: 10px;
            font-size: 13px;
            color: #cbd5e0;
          }
          hr {
            border: none;
            border-top: 1px solid #e2e8f0;
            margin: 20px 0;
          }
          @media only screen and (max-width: 600px) {
            .content {
              padding: 15px;
            }
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <img src="${LOGO_BLUE_BASE64}" alt="NELHEALTHCOACH" class="logo">
          </div>
          <div class="content">
            ${content}
          </div>
          <div class="footer">
            <div style="margin-bottom: 15px;">
              <strong>NELHEALTHCOACH</strong><br>
              Transformando vidas a través de la salud integral y hábitos sostenibles
            </div>
            <div class="contact-info">
              📧 <a href="mailto:contact@nelhealthcoach.com">contact@nelhealthcoach.com</a><br>
              📞 Español: ${CONTACT_PHONE_ES || '+1 (442) 342-5050'} | English: ${CONTACT_PHONE_EN || '+1 (760) 980-5880'}<br>
              📍 ${CONTACT_ADDRESS || '33450 Shifting Sands Trail, Cathedral City, CA 92234'}<br>
              🌐 <a href="${WEBSITE_URL}">${WEBSITE_URL}</a>
            </div>
            <div style="margin-top: 20px; font-size: 12px; opacity: 0.7;">
              © ${new Date().getFullYear()} NELHEALTHCOACH, LLC. Todos los derechos reservados.
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    // Contenido para el correo del cliente
    const clientContent = `
      <h1>¡Gracias por contactarnos, ${name}!</h1>
      <p>Hemos recibido tu solicitud para agendar una sesión gratuita. En breve recibirás la confirmación de tu cita por parte de Calendly.</p>
      
      <div class="data-block">
        <div class="data-row">
          <span class="data-label">Objetivo:</span>
          <span class="data-value">${objective}</span>
        </div>
        ${phone ? `
        <div class="data-row">
          <span class="data-label">Teléfono:</span>
          <span class="data-value">${phone}</span>
        </div>
        ` : ''}
      </div>
      
      <hr>
      
      <p style="font-size: 14px; color: #718096;">
        <strong>Próximos pasos:</strong> Recibirás un enlace de Calendly con el enlace a la reunión pautada.
      </p>
    `;

    // Contenido para el correo del coach
    const coachContent = `
      <h1>📋 Nuevo lead para sesión gratuita</h1>
      
      <div class="data-block">
        <div class="data-row">
          <span class="data-label">Nombre:</span>
          <span class="data-value">${name}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Email:</span>
          <span class="data-value">${email}</span>
        </div>
        ${phone ? `
        <div class="data-row">
          <span class="data-label">Teléfono:</span>
          <span class="data-value">${phone}</span>
        </div>
        ` : ''}
        <div class="data-row">
          <span class="data-label">Objetivo:</span>
          <span class="data-value">${objective}</span>
        </div>
        <div class="data-row">
          <span class="data-label">Fecha:</span>
          <span class="data-value">${new Date().toLocaleString('es-ES')}</span>
        </div>
      </div>
      
      <p>Puedes contactar con este lead para coordinar la sesión gratuita.</p>
    `;

    // Enviar correo al cliente
    logger.info('LEAD', 'Enviando email al cliente...');
    await resend.emails.send({
      from: 'Servicio Automático de NELHEALTHCOACH <no-reply@nelhealthcoach.com>',
      to: email,
      subject: 'Gracias por agendar tu sesión gratuita | NELHEALTHCOACH',
      html: baseHtml(clientContent),
    });
    logger.info('LEAD', 'Email al cliente enviado');

    // Enviar correo al coach (solo si CONTACT_EMAIL está definido)
    if (CONTACT_EMAIL) {
      logger.info('LEAD', 'Enviando email al coach...');
      await resend.emails.send({
        from: 'Servicio Automático de NELHEALTHCOACH <no-reply@nelhealthcoach.com>',
        to: CONTACT_EMAIL,
        subject: 'Nuevo lead - Sesión gratuita',
        html: baseHtml(coachContent),
      });
      logger.info('LEAD', 'Email al coach enviado');
    } else {
      logger.warn('LEAD', 'No se envió email al coach porque CONTACT_EMAIL no está definido');
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('LEAD', 'Error capturado:', error);
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