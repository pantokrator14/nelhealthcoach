import { NextRequest, NextResponse } from 'next/server';
import { getHealthFormsCollection, getLeadsCollection, connectMongoose } from '@/app/lib/database';
import { encrypt, decrypt, decryptFileObject, safeDecrypt, isEncrypted } from '@/app/lib/encryption';
import { logger } from '@/app/lib/logger';
import { requireCoachAuth, generateToken } from '@/app/lib/auth';
import { secureRoute } from '@/app/lib/security/index';
import { clientFormSchema } from '@/app/lib/schemas';
import Coach from '@/app/models/Coach';
import { EmailService } from '@/app/lib/email-service';
import {
  generateNewClientClientNotificationHTML,
  generateNewClientCoachNotificationHTML,
} from '@/app/lib/email-templates';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';

interface MedicalData {
  mainComplaint: string;
  medications: string;
  supplements: string;
  currentPastConditions: string;
  additionalMedicalHistory: string;
  employmentHistory: string;
  hobbies: string;
  allergies: string;
  surgeries: string;
  housingHistory: string;
  carbohydrateAddiction: string;
  leptinResistance: string;
  circadianRhythms: string;
  sleepHygiene: string;
  electrosmogExposure: string;
  generalToxicity: string;
  microbiotaHealth: string;
  mentalHealthEmotionIdentification: string;
  mentalHealthEmotionIntensity: string;
  mentalHealthUncomfortableEmotion: string;
  mentalHealthInternalDialogue: string;
  mentalHealthStressStrategies: string;
  mentalHealthSayingNo: string;
  mentalHealthRelationships: string;
  mentalHealthExpressThoughts: string;
  mentalHealthEmotionalDependence: string;
  mentalHealthPurpose: string;
  mentalHealthFailureReaction: string;
  mentalHealthSelfConnection: string;
  mentalHealthSelfRelationship: string;
  mentalHealthLimitingBeliefs: string;
  mentalHealthIdealBalance: string;
  // Nuevos campos
  typicalWeekday?: string;
  typicalWeekend?: string;
  whoCooks?: string;
  currentActivityLevel?: string;
  physicalLimitations?: string;
  gymAccess?: string;
  gymAccessDetails?: string;
  preferredExerciseTypes?: string;
  exerciseTimeAvailability?: string;
  documents?: unknown[];
}

interface PersonalData {
  name: string;
  address: string;
  phone: string;
  email: string;
  birthDate: string;
  gender: string;
  age: string;
  weight: string;
  height: string;
  maritalStatus: string;
  education: string;
  occupation: string;
}

interface ClientFormData {
  personalData: PersonalData;
  medicalData: MedicalData;
  contractAccepted: boolean;
}

// GET: Listar clientes (dashboard, filtrado por coach)
async function getHandler(request: NextRequest) {
  return logger.time('CLIENTS', 'Obtener lista de clientes', async () => {
    try {
      logger.info('CLIENTS', 'Solicitud GET /api/clients recibida', undefined, {
        endpoint: '/api/clients',
        method: 'GET'
      });

      // Autenticar coach (obligatorio)
      const auth = requireCoachAuth(request);

      const healthForms = await getHealthFormsCollection();

      // Construir filtro
      const filter: Record<string, unknown> = {};
      if (auth.role === 'coach') {
        // Coach solo ve sus clientes
        filter.coachId = auth.coachId;
      }
      // Admin ve todos (no filtra)

      const totalCount = await healthForms.countDocuments(filter);
      logger.debug('CLIENTS', `Total documentos en BD para este filtro: ${totalCount}`);

      const clients = await healthForms
        .find(filter)
        .sort({ submissionDate: -1 })
        .toArray();

      logger.info('CLIENTS', `Documentos obtenidos: ${clients.length}`, {
        firstClientId: clients[0]?._id?.toString()
      });

      // ✅ FUNCIÓN MEJORADA PARA DESENCRIPTAR CAMPOS DE TEXTO
      // Soporta el formato v2 (AES-256-GCM, prefijo "v2:") y el legacy
      // (CryptoJS, prefijo "U2FsdGVkX1"). decrypt() ya detecta ambos,
      // y devuelve el texto tal cual si no está encriptado o si falla la clave.
      const decryptTextField = (text: string): string => {
        if (!text) return text;
        return decrypt(text);
      };

      // Procesar y desencriptar clientes
      const clientList = clients.map(client => {
        try {
          // ✅ USAR decryptTextField EN LUGAR DE smartDecrypt PARA CAMPOS DE TEXTO
          const decryptedName = decryptTextField(client.personalData?.name || '');
          const names = decryptedName.split(' ');
          
          // ✅ PROFILE PHOTO - Desencriptar correctamente
          let decryptedProfilePhoto = null;
          if (client.personalData?.profilePhoto) {
            try {
              decryptedProfilePhoto = decryptFileObject(client.personalData.profilePhoto);
            } catch (error) {
              logger.warn('CLIENTS', `Error desencriptando profilePhoto para cliente ${client._id}`, error as Error);
              decryptedProfilePhoto = null;
            }
          }

          const result = {
            _id: client._id.toString(),
            firstName: names[0] || '',
            lastName: names.slice(1).join(' ') || '',
            email: decryptTextField(client.personalData?.email || ''),
            phone: decryptTextField(client.personalData?.phone || ''),
            createdAt: client.submissionDate,
            profilePhoto: decryptedProfilePhoto
          };

          // ✅ LOG PARA VERIFICAR DESENCRIPTACIÓN
          logger.debug('CLIENTS', 'Cliente procesado', {
            clientId: client._id.toString(),
            nameRaw: client.personalData?.name?.substring(0, 30) || 'N/A',
            nameDecrypted: result.firstName + ' ' + result.lastName,
            emailDecrypted: result.email?.substring(0, 30) || 'N/A',
            wasEncrypted: isEncrypted(client.personalData?.name || '')
          });

          return result;
        } catch (error) {
          logger.error('CLIENTS', `Error procesando cliente ${client._id}`, error as Error, {
            clientId: client._id.toString(),
            personalDataKeys: Object.keys(client.personalData || {})
          });
          
          return {
            _id: client._id.toString(),
            firstName: 'Error',
            lastName: 'Desencriptación',
            email: 'error@example.com',
            phone: 'N/A',
            createdAt: client.submissionDate,
            profilePhoto: null
          };
        }
      });

      logger.info('CLIENTS', `Procesamiento completado: ${clientList.length} clientes`, {
        successCount: clientList.filter(c => c.firstName !== 'Error').length,
        errorCount: clientList.filter(c => c.firstName === 'Error').length
      });

      return NextResponse.json({
        success: true,
        data: clientList,
        metadata: {
          total: clientList.length,
          processed: clientList.length
        }
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

      logger.error('CLIENTS', 'Error obteniendo lista de clientes', error, {
        endpoint: '/api/clients',
        method: 'GET'
      });
      
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  }, { endpoint: '/api/clients' });
}

export const GET = apiHandler(getHandler);

// POST: Crear nuevo cliente (desde formulario)
async function postHandler(request: NextRequest) {
  try {
    const data = await request.json();
    const clientIP = request.headers.get('x-forwarded-for') || 
                    request.headers.get('x-real-ip') || 
                    'Unknown';

    // Request context para audit logs
    const reqCtx = {
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      requestId: request.headers.get('x-request-id') || undefined,
    };

    // Verificación de seguridad: rate limit + shield body scan
    const securityCheck = await secureRoute(request, data);
    if (!securityCheck.passed) {
      return NextResponse.json(
        { success: false, message: securityCheck.message ?? 'Solicitud bloqueada por seguridad' },
        {
          status: securityCheck.statusCode ?? 429,
          ...(securityCheck.retryAfter && { headers: { 'Retry-After': String(securityCheck.retryAfter) } }),
        }
      );
    }

    // Extraer coachId del body (enviado por el form)
    const coachId = data.coachId || null;
    const isFree = data.free === true;
    const stripeSessionId = data.stripeSessionId as string | undefined;

    // ─── Validación de pago ────────────────────────────────────────
    // 1. Si es gratuito, validar que el coach sea admin
    // 2. Si no es gratuito, verificar que Stripe confirme el pago

    if (isFree) {
      if (!coachId) {
        // &free=1 sin coachId: alguien lo añadió manualmente a la URL
        logger.warn('CLIENTS', 'Intento de registro gratuito sin coachId — posible manipulación', {
          isFree,
        });
        return NextResponse.json(
          { success: false, message: 'Acción no autorizada. El enlace gratuito solo es válido con un coach administrador.', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }

      // Verificar que el coach sea administrador
      await connectMongoose();
      const coach = await Coach.findById(coachId).select('role').lean() as { role: string } | null;
      if (!coach || coach.role !== 'admin') {
        logger.warn('CLIENTS', 'Intento de registro gratuito con coach no autorizado', {
          coachId,
        });
        return NextResponse.json(
          { success: false, message: 'Acción no autorizada. El enlace gratuito solo puede ser generado por un administrador.', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }
      logger.info('CLIENTS', 'Registro gratuito autorizado — coach admin verificado', { coachId });
    } else {
      // No es gratuito: requiere verificación de pago con Stripe
      if (!stripeSessionId) {
        logger.warn('CLIENTS', 'Intento de registro sin pago y sin stripeSessionId', {
          hasCoachId: !!coachId,
        });
        return NextResponse.json(
          { success: false, message: 'No se puede completar el registro sin un pago válido.', code: 'VALIDATION'},
          { status: 402 }
        );
      }

      // Verificar la sesión de Stripe
      try {
        const { stripeClient } = await import('@/app/lib/stripe');
        const session = await stripeClient.checkout.sessions.retrieve(stripeSessionId);

        if (session.payment_status !== 'paid') {
          logger.warn('CLIENTS', 'Sesión de Stripe no pagada', {
            stripeSessionId,
            paymentStatus: session.payment_status,
          });
          return NextResponse.json(
            { success: false, message: 'El pago no fue completado. Por favor intenta de nuevo.', code: 'VALIDATION'},
            { status: 402 }
          );
        }

        logger.info('CLIENTS', 'Pago verificado con Stripe exitosamente', {
          stripeSessionId,
        });
      } catch (stripeError) {
        logger.error('CLIENTS', 'Error verificando sesión de Stripe', stripeError as Error, {
          stripeSessionId,
        });
        return NextResponse.json(
          { success: false, message: 'Error verificando el pago. Contacta a soporte.', code: 'INTERNAL'},
          { status: 500 }
        );
      }
    }

    // Zod validation
    const parsed = clientFormSchema.safeParse(data);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      // Log detallado al servidor
      console.error('❌ Validación Zod fallida al crear cliente:', JSON.stringify({
        issues: parsed.error.issues.map(i => ({
          field: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
        coachId,
        clientIP,
      }, null, 2));
      logger.warn('CLIENTS', 'Validación Zod fallida al crear cliente', undefined, {
        issues: parsed.error.issues.length,
        firstField: firstError?.path?.join('.'),
        coachId,
      });
      return NextResponse.json(
        {
          success: false,
          message: firstError?.message ?? 'Datos del formulario inválidos',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
          code: 'VALIDATION',
        },
        { status: 400 },
      );
    }

    // Zod validated — `data` tiene la forma correcta
    // Las fields faltantes se manejan con defaults en el processing code

    const healthForms = await getHealthFormsCollection();

    // Función para encriptar objetos
    const encryptObject = (obj: Record<string, unknown>): Record<string, unknown> => {
      const encrypted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Manejar array de documentos de forma especial (no encriptar el array completo)
        if (key === 'documents' && Array.isArray(value)) {
          encrypted[key] = value;
          continue;
        }
        
        if (typeof value === 'string' && value.trim() !== '') {
          encrypted[key] = encrypt(value);
        } else if (typeof value === 'object' && value !== null) {
          // ✅ ENCRIPTAR OBJETOS COMPLETOS como profilePhoto y documents
          if (Array.isArray(value)) {
            // Para arrays como documents, encriptar cada elemento del array
            encrypted[key] = encrypt(JSON.stringify(value.map((item: unknown) => 
              typeof item === 'object' && item !== null ? encryptObject(item as Record<string, unknown>) : item
            )));
          } else {
            // Para objetos como profilePhoto
            encrypted[key] = encrypt(JSON.stringify(encryptObject(value as Record<string, unknown>)));
          }
        } else {
          encrypted[key] = value;
        }
      }
      return encrypted;
    };

    // Procesar arrays en medicalData
    const processedMedicalData = { ...data.medicalData };

    const expectedLengths: Record<string, number> = {
      carbohydrateAddiction: 11,
      leptinResistance: 8,
      circadianRhythms: 11,
      sleepHygiene: 12,
      electrosmogExposure: 10,
      generalToxicity: 10,
      microbiotaHealth: 12,
    };

    const typedMedicalData = processedMedicalData as Record<string, unknown>;
    const arrayFields = [
      'carbohydrateAddiction', 'leptinResistance', 'circadianRhythms',
      'sleepHygiene', 'electrosmogExposure', 'generalToxicity', 'microbiotaHealth'
    ];

    arrayFields.forEach(field => {
      const arrayData = typedMedicalData[field];
      const expectedLength = expectedLengths[field];
      
      if (!arrayData || !Array.isArray(arrayData)) {
        typedMedicalData[field] = JSON.stringify([]);
        return;
      }

      // ✅ CORREGIDO: Ya no convertimos a booleano, mantenemos los strings originales
      const cleanedArray = arrayData.map((value: unknown) => {
        // Si ya es string, lo dejamos como está
        if (typeof value === 'string') return value;
        // Si es booleano (por si acaso), lo convertimos a 'si'/'no'
        if (typeof value === 'boolean') return value ? 'si' : 'no';
        // Si es número, lo convertimos a string
        if (typeof value === 'number') return value.toString();
        // Por defecto, string vacío
        return '';
      });

      // Asegurar longitud
      if (cleanedArray.length < expectedLength) {
        while (cleanedArray.length < expectedLength) {
          cleanedArray.push('');
        }
      } else if (cleanedArray.length > expectedLength) {
        cleanedArray.length = expectedLength;
      }

      typedMedicalData[field] = JSON.stringify(cleanedArray);
    });

    // Inicializar array de documentos vacío
    processedMedicalData.documents = [];

    // Encriptar datos antes de guardar
    const encryptedPersonalData = encryptObject(data.personalData);
    const encryptedMedicalData = encryptObject(processedMedicalData);

    const newClient = {
      personalData: encryptedPersonalData,
      medicalData: encryptedMedicalData,
      contractAccepted: encrypt(data.contractAccepted.toString()),
      // Registro de evidencia de consentimiento: versión del contrato y fecha de aceptación
      contractVersion: data.contractVersion || null,
      contractAcceptedAt: data.contractAccepted ? new Date() : null,
      ipAddress: encrypt(clientIP),
      coachId: coachId || null,
      submissionDate: new Date()
    };

    console.log('🆕 Insertando nuevo cliente en MongoDB...');
    logger.info('CLIENTS', 'Insertando nuevo cliente en MongoDB');
    const result = await healthForms.insertOne(newClient);
    
    console.log('✅ Cliente insertado:', {
      insertedId: result.insertedId,
      insertedIdString: result.insertedId.toString(),
      acknowledged: result.acknowledged
    });
    logger.info('CLIENTS', 'Cliente insertado exitosamente', {
      insertedId: result.insertedId.toString(),
      acknowledged: result.acknowledged
    });

    // Después de la inserción exitosa
    if (result.acknowledged) {
      // Buscar y eliminar el lead correspondiente por email (sin encriptar)
      try {
        const leadsCollection = await getLeadsCollection();
        const emailToMatch = data.personalData.email; // El email viene en texto plano en la request
        const deleteResult = await leadsCollection.deleteOne({ email: emailToMatch });
        if (deleteResult.deletedCount > 0) {
          console.log(`✅ Lead con email ${emailToMatch} eliminado correctamente.`);
          logger.info('CLIENTS', `Lead con email ${emailToMatch} eliminado correctamente`);
        } else {
          console.log(`ℹ️ No se encontró lead con email ${emailToMatch} para eliminar.`);
          logger.info('CLIENTS', `No se encontró lead con email ${emailToMatch} para eliminar`);
        }
      } catch (leadError) {
        // Solo logueamos el error, no interrumpimos el flujo principal
        console.error('❌ Error al eliminar lead:', leadError);
        logger.error('CLIENTS', 'Error al eliminar lead', leadError);
      }

      // Enviar emails de notificación si hay coachId
      if (coachId && result.acknowledged) {
        try {
          await connectMongoose();
          const coach = await Coach.findById(coachId);
          if (coach) {
            const emailService = EmailService.getInstance();
            const appUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

            const clientName = decrypt(data.personalData.name || '');
            const clientEmail = data.personalData.email;
            const clientPhone = data.personalData.phone ? decrypt(data.personalData.phone) : '';
            const coachName = `${decrypt(coach.firstName)} ${decrypt(coach.lastName)}`;
            const coachEmail = decrypt(coach.email);
            const coachPhone = coach.phone ? decrypt(coach.phone) : '';
            const coachPhotoUrl = coach.profilePhoto?.url ? decrypt(coach.profilePhoto.url) : null;

            await emailService.sendEmail({
              to: [clientEmail],
              subject: '¡Bienvenido a NELHEALTHCOACH!',
              htmlBody: generateNewClientClientNotificationHTML({
                clientName,
                coachName,
                coachEmail,
                coachPhone,
                coachPhoto: coachPhotoUrl,
              }),
            });

            await emailService.sendEmail({
              to: [coachEmail],
              subject: `Nuevo cliente registrado: ${clientName} | NELHEALTHCOACH`,
              htmlBody: generateNewClientCoachNotificationHTML({
                coachName: decrypt(coach.firstName),
                clientName,
                clientEmail,
                clientPhone: clientPhone || 'No disponible',
                clientId: result.insertedId.toString(),
                dashboardUrl: `${appUrl}/dashboard/clients/${result.insertedId}`,
              }),
            });

            logger.info('CLIENTS', 'Emails de notificación enviados', {
              clientId: result.insertedId.toString(),
              coachId,
            });
          }
        } catch (emailError) {
          // No interrumpir el flujo si falla el email
          logger.error('CLIENTS', 'Error enviando emails de notificación', emailError);
        }
      }
    }

    // Generar token temporal para subir archivos (1 hora de validez)
    const uploadToken = generateToken({
      type: 'client-upload',
      clientId: result.insertedId.toString(),
    });

    const responseData = {
      success: true,
      message: 'Cliente registrado exitosamente',
      data: {
        _id: result.insertedId.toString(),
        uploadToken,
      }
    };

    console.log('📤 Enviando respuesta al frontend:', responseData);
    logger.info('CLIENTS', 'Enviando respuesta al frontend', responseData);

    const decryptedName = decrypt(data.personalData.name || '');
    logAuditEvent({
      eventType: 'CLIENT_CREATED',
      severity: 'info',
      message: `Cliente creado: ${decryptedName}`,
      coachId: coachId,
      ...reqCtx,
      path: '/api/clients',
      method: 'POST',
      statusCode: 201,
    });
    
    return NextResponse.json(responseData, { status: 201 });

  } catch (error) {
    console.error('❌ Error creando cliente:', error);
    logger.error('CLIENTS', 'Error creando cliente', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error interno del servidor al registrar el cliente',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const POST = apiHandler(postHandler);