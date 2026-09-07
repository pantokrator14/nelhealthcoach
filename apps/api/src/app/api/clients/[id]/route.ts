// apps/api/src/app/api/clients/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getHealthFormsCollection } from '@/app/lib/database';
import { decrypt, decryptFileObject, encrypt, encryptFileObject, isEncrypted, safeDecrypt } from '@/app/lib/encryption';
import { requireAuth, requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { S3Service } from '@/app/lib/s3';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';

// GET: Obtener un cliente específico
async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return logger.time('CLIENTS', 'Obtener cliente específico', async () => {
    try {
      const { id } = await params;
      
      logger.info('CLIENTS', 'Solicitud GET /api/clients/[id] recibida', undefined, {
        endpoint: `/api/clients/${id}`,
        method: 'GET',
        clientId: id
      });

      // Verificar autenticación con coachId
      let auth;
      try {
        auth = requireCoachAuth(request);
      } catch {
        // Legacy: usar requireAuth viejo
        const token = request.headers.get('authorization')?.replace('Bearer ', '');
        requireAuth(token);
        auth = null;
      }

      const healthForms = await getHealthFormsCollection();

      // Verificar ownership si es coach no-admin
      let filter: Record<string, unknown> = { _id: new ObjectId(id) };
      if (auth && auth.role === 'coach') {
        filter.coachId = auth.coachId;
      }

      logger.debug('CLIENTS', 'Buscando cliente en la base de datos', { clientId: id });

      const client = await healthForms.findOne(filter);

      if (!client) {
        logger.warn('CLIENTS', 'Cliente no encontrado', undefined, { clientId: id });
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado', code: 'NOT_FOUND'},
          { status: 404 }
        );
      }
      logger.debug('CLIENTS', 'Estructura del cliente en BD:', {
        clientId: client._id.toString(),
        personalDataKeys: Object.keys(client.personalData || {}),
        medicalDataKeys: Object.keys(client.medicalData || {}),
        hasProfilePhoto: !!client.personalData.profilePhoto,
        profilePhotoType: typeof client.personalData.profilePhoto,
        hasDocuments: !!client.medicalData.documents,
        documentsType: typeof client.medicalData.documents,
        sampleMedicalField: {
          carbohydrateAddiction: {
            value: client.medicalData.carbohydrateAddiction,
            type: typeof client.medicalData.carbohydrateAddiction,
            preview: typeof client.medicalData.carbohydrateAddiction === 'string' ? 
              client.medicalData.carbohydrateAddiction.substring(0, 50) + '...' : 'N/A'
          }
        }
      });
      logger.debug('CLIENTS', 'Cliente encontrado', {
        clientId: client._id.toString(),
        hasPersonalData: !!client.personalData,
        personalDataKeys: Object.keys(client.personalData || {})
      });

      // Función para desencriptar objetos - MEJORADA
      const decryptObject = (obj: Record<string, any>, path: string = ''): Record<string, any> => {
        const decrypted: Record<string, any> = {};
        
        for (const [key, value] of Object.entries(obj)) {
          const currentPath = path ? `${path}.${key}` : key;
          
          const isFileField = (
            currentPath.includes('profilePhoto.url') || 
            currentPath.includes('profilePhoto.key') || 
            currentPath.includes('documents.url') ||
            currentPath.includes('documents.key') ||
            (currentPath === 'profilePhoto.type') ||
            (currentPath === 'documents.type') ||
            currentPath.includes('uploadedAt')
          );
          
          if (typeof value === 'string' && value.trim() !== '') {
            if (isFileField) {
              decrypted[key] = value;
            } else {
              // ✅ USAR safeDecrypt EN LUGAR DE smartDecrypt
              decrypted[key] = safeDecrypt(value);
            }
          } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            decrypted[key] = decryptObject(value, currentPath);
          } else {
            decrypted[key] = value;
          }
        }
        
        return decrypted;
      };

      // Función para desencriptar arrays de objetos (como documents)
      const decryptArray = (encryptedArray: string): any[] => {
        if (!encryptedArray) return [];
        
        try {
          // Primero desencriptar el string completo
          const decryptedString = decrypt(encryptedArray);
          // Luego parsear como JSON
          const parsedArray = JSON.parse(decryptedString);
          
          if (!Array.isArray(parsedArray)) {
            logger.warn('ENCRYPTION', 'El resultado desencriptado no es un array', { 
              decryptedString: decryptedString.substring(0, 100) 
            });
            return [];
          }
          
          // Desencriptar cada objeto en el array
          return parsedArray.map(item => {
            if (typeof item === 'object' && item !== null) {
              const decryptedItem: any = {};
              for (const [key, value] of Object.entries(item)) {
                if (typeof value === 'string') {
                  try {
                    decryptedItem[key] = decrypt(value);
                  } catch (error) {
                    decryptedItem[key] = value; // Mantener original si falla
                    logger.debug('ENCRYPTION', `No se pudo desencriptar campo ${key} en documento`, { value });
                  }
                } else {
                  decryptedItem[key] = value;
                }
              }
              return decryptedItem;
            }
            return item;
          });
        } catch (error) {
          logger.error('ENCRYPTION', 'Error desencriptando array', error as Error, {
            encryptedArray: encryptedArray?.substring(0, 100)
          });
          return [];
        }
      };

      // Desencriptar datos del cliente (PERO documents y processedDocuments se manejan aparte)
      const rawMedicalData = { ...client.medicalData };
      // Extraer y limpiar campos que se manejan aparte para evitar doble desencriptado
      const rawDocuments = rawMedicalData.documents;
      const rawProcessedDocuments = rawMedicalData.processedDocuments;
      delete rawMedicalData.documents;
      delete rawMedicalData.processedDocuments;

      const decryptedClient = {
        _id: client._id.toString(),
        personalData: decryptObject(client.personalData),
        medicalData: decryptObject(rawMedicalData),
        contractAccepted: safeDecrypt(client.contractAccepted) === 'true',
        contractVersion: client.contractVersion || null,
        contractAcceptedAt: client.contractAcceptedAt || null,
        ipAddress: safeDecrypt(client.ipAddress),
        submissionDate: client.submissionDate,
        // Incluir sesiones de video para que el dashboard gestione transcripciones
        videoSessions: (client.videoSessions as Record<string, unknown>[]) || [],
      };

      // Restaurar documents y processedDocuments para procesarlos aparte
      (decryptedClient.medicalData as Record<string, unknown>).documents = rawDocuments;
      (decryptedClient.medicalData as Record<string, unknown>).processedDocuments = rawProcessedDocuments;

      logger.debug('CLIENTS', 'Verificación de datos desencriptados', {
        clientId: id,
        name: decryptedClient.personalData.name ? 'DESENCRIPTADO' : 'FALLO',
        email: decryptedClient.personalData.email ? 'DESENCRIPTADO' : 'FALLO',
        hasProfilePhoto: !!decryptedClient.personalData.profilePhoto,
        profilePhotoUrl: decryptedClient.personalData.profilePhoto?.url ? 'EXISTS' : 'MISSING',
        documentCount: decryptedClient.medicalData.documents?.length || 0
      });

      // Procesar arrays en medicalData
      const arrayFields = [
        'carbohydrateAddiction', 'leptinResistance', 'circadianRhythms',
        'sleepHygiene', 'electrosmogExposure', 'generalToxicity', 'microbiotaHealth'
      ];

      arrayFields.forEach(field => {
        const fieldData = (decryptedClient.medicalData as any)[field];
        
        if (!fieldData) {
          (decryptedClient.medicalData as any)[field] = [];
          return;
        }

        if (Array.isArray(fieldData)) {
          (decryptedClient.medicalData as any)[field] = fieldData;
        } else if (typeof fieldData === 'string') {
          // ✅ CORRECCIÓN: SOLO desencriptar si está encriptado
          let stringToParse = fieldData;
          
          // Si está encriptado (formato v2 o legacy), desencriptar
          if (isEncrypted(fieldData)) {
            stringToParse = safeDecrypt(fieldData);
            logger.debug('CLIENTS', `Campo ${field} desencriptado`, {
              clientId: id,
              wasEncrypted: true
            });
          } else {
            logger.debug('CLIENTS', `Campo ${field} ya está desencriptado`, {
              clientId: id,
              wasEncrypted: false
            });
          }
          
          try {
            const parsed = JSON.parse(stringToParse);
            if (Array.isArray(parsed)) {
              (decryptedClient.medicalData as any)[field] = parsed;
              logger.debug('CLIENTS', `${field} procesado exitosamente`, {
                clientId: id,
                wasEncrypted: fieldData !== stringToParse,
                arrayLength: parsed.length
              });
            } else {
              throw new Error('El resultado no es un array');
            }
          } catch (error) {
            logger.warn('CLIENTS', `Error procesando ${field}, usando array vacío`, undefined, {
              clientId: id,
              field
            });
            (decryptedClient.medicalData as any)[field] = [];
          }
        } else {
          (decryptedClient.medicalData as any)[field] = [];
        }
      });

      // ✅ DESENCRIPTAR profilePhoto
      if (decryptedClient.personalData.profilePhoto) {
        try {
          decryptedClient.personalData.profilePhoto = decryptFileObject(decryptedClient.personalData.profilePhoto);
        } catch (error) {
          logger.error('CLIENTS', 'Error desencriptando profilePhoto', error as Error, { clientId: id });
          decryptedClient.personalData.profilePhoto = null;
        }
      }

      // ✅ DESENCRIPTAR documents
      if (decryptedClient.medicalData.documents) {
        if (typeof decryptedClient.medicalData.documents === 'string') {
          try {
            // Desencriptar el string completo
            const decryptedString = decrypt(decryptedClient.medicalData.documents);
            const parsedArray = JSON.parse(decryptedString);
            
            if (Array.isArray(parsedArray)) {
              // Desencriptar cada archivo en el array
              decryptedClient.medicalData.documents = parsedArray.map(file => 
                decryptFileObject(file)
              );
            } else {
              decryptedClient.medicalData.documents = [];
            }
          } catch (error) {
            logger.error('CLIENTS', 'Error desencriptando documents', error as Error, { clientId: id });
            decryptedClient.medicalData.documents = [];
          }
        } else if (Array.isArray(decryptedClient.medicalData.documents)) {
          // Si ya es array, desencriptar cada elemento
          decryptedClient.medicalData.documents = decryptedClient.medicalData.documents.map(file => 
            decryptFileObject(file)
          );
        }
      }

      logger.info('CLIENTS', 'Cliente desencriptado exitosamente', { clientId: id });

      return NextResponse.json({
        success: true,
        data: decryptedClient
      });

      

    } catch (error: any) {
      logger.error('CLIENTS', 'Error obteniendo cliente', error, {
        endpoint: `/api/clients/${(await params).id}`,
        method: 'GET',
        clientId: (await params).id
      });
      
      if (error.message.includes('Token')) {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
          { status: 401 }
        );
      }

      if (error.message.includes('ObjectId')) {
        return NextResponse.json(
          { success: false, message: 'ID de cliente inválido', code: 'VALIDATION'},
          { status: 400 }
        );
      }

      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  }, { endpoint: `/api/clients/${(await params).id}`, clientId: (await params).id });
}

export const GET = apiHandler(getHandler);

// PUT: Actualizar cliente
async function putHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return logger.time('CLIENTS', 'Actualizar cliente', async () => {
    try {
      const { id } = await params;
      
      logger.info('CLIENTS', 'Solicitud PUT /api/clients/[id] recibida', undefined, {
        endpoint: `/api/clients/${id}`,
        method: 'PUT',
        clientId: id
      });

      // Request context para audit logs
      const reqCtx = {
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        requestId: request.headers.get('x-request-id') || undefined,
      };

      // === DEFINICIONES CRÍTICAS ===
      const arrayFields = [
        'carbohydrateAddiction', 'leptinResistance', 'circadianRhythms',
        'sleepHygiene', 'electrosmogExposure', 'generalToxicity', 'microbiotaHealth'
      ];

      const expectedLengths: Record<string, number> = {
        carbohydrateAddiction: 11,
        leptinResistance: 8,
        circadianRhythms: 11,
        sleepHygiene: 12,
        electrosmogExposure: 10,
        generalToxicity: 10,
        microbiotaHealth: 12,
      };
      // === FIN DEFINICIONES ===

      logger.debug('CLIENTS', 'Definiciones cargadas para actualización', {
        clientId: id,
        arrayFields,
        expectedLengths
      });

      // Verificar autenticación + ownership
      let auth;
      try {
        auth = requireCoachAuth(request);
      } catch {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
          { status: 401 }
        );
      }

      // Verificar ownership: solo admin o el coach dueño del cliente puede editar
      const healthForms = await getHealthFormsCollection();
      const existingClient = await healthForms.findOne(
        { _id: new ObjectId(id) },
        { projection: { coachId: 1 } }
      );

      if (!existingClient) {
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado', code: 'NOT_FOUND'},
          { status: 404 }
        );
      }

      if (auth.role !== 'admin' && existingClient.coachId !== auth.coachId) {
        logger.warn('CLIENTS', 'Intento de acceso no autorizado a cliente', {
          coachId: auth.coachId,
          clientId: id,
          clientCoachId: existingClient.coachId,
        });
        return NextResponse.json(
          { success: false, message: 'No tienes permiso para modificar este cliente', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }

      const data = await request.json();
      
      const evaluationFields = arrayFields.map(field => ({
        field,
        value: data.medicalData?.[field],
        type: typeof data.medicalData?.[field],
        isArray: Array.isArray(data.medicalData?.[field])
      }));
      
      logger.debug('CLIENTS', 'Datos recibidos para actualización', {
        clientId: id,
        personalDataKeys: Object.keys(data.personalData || {}),
        medicalDataKeys: Object.keys(data.medicalData || {}),
        evaluationFields: evaluationFields as any
      });

      // Validar datos
      if (!data.personalData || !data.medicalData) {
        logger.warn('CLIENTS', 'Datos incompletos para actualización', undefined, { clientId: id });
        return NextResponse.json(
          { success: false, message: 'Datos incompletos', code: 'VALIDATION'},
          { status: 400 }
        );
      }

      // ✅ ELIMINADA la función decryptObject duplicada - ya existe en el GET

      // Función para encriptar objetos de datos personales/médicos
      const encryptObjectData = (obj: Record<string, any>): Record<string, any> => {
        const encrypted: Record<string, any> = {};
        
        for (const [key, value] of Object.entries(obj)) {
          // ✅ NO encriptar campos de archivos (ya se encriptan individualmente)
          const isFileField = key === 'profilePhoto' || key === 'documents';
          
          if (typeof value === 'string' && value.trim() !== '') {
            // ✅ Solo encriptar si no está ya encriptado (v2 o legacy)
            if (isFileField || isEncrypted(value)) {
              encrypted[key] = value;
            } else {
              encrypted[key] = encrypt(value);
            }
          } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            encrypted[key] = encryptObjectData(value);
          } else {
            encrypted[key] = value;
          }
        }
        
        return encrypted;
      };

      // ✅ Función específica para procesar y encriptar arrays de evaluaciones
      const processAndEncryptArray = (field: string, arrayData: any[]): string => {
        const expectedLength = expectedLengths[field];
        
        if (!arrayData || !Array.isArray(arrayData)) {
          logger.warn('CLIENTS', `Array ${field} no válido, usando array vacío`, undefined, { clientId: id });
          return encrypt(JSON.stringify([]));
        }

        // ✅ CORREGIDO: Mantener los strings originales, no convertir a booleano
        const cleanedArray = arrayData.map((value: any) => {
          if (typeof value === 'string') return value;
          if (typeof value === 'boolean') return value ? 'si' : 'no';
          if (typeof value === 'number') return value.toString();
          return '';
        });

        // Asegurar longitud
        if (cleanedArray.length < expectedLength) {
          logger.debug('CLIENTS', `Extendiendo array ${field} a longitud esperada`, {
            clientId: id,
            currentLength: cleanedArray.length,
            expectedLength
          });
          while (cleanedArray.length < expectedLength) {
            cleanedArray.push('');
          }
        } else if (cleanedArray.length > expectedLength) {
          logger.debug('CLIENTS', `Recortando array ${field} a longitud esperada`, {
            clientId: id,
            currentLength: cleanedArray.length,
            expectedLength
          });
          cleanedArray.length = expectedLength;
        }

        // ENCRIPTAR el array como string JSON
        const encryptedArray = encrypt(JSON.stringify(cleanedArray));
        
        logger.debug('CLIENTS', `Array ${field} procesado y encriptado`, {
          clientId: id,
          finalLength: cleanedArray.length
        });
        
        return encryptedArray;
      };

      // Procesar arrays en medicalData
      const processedMedicalData = { ...data.medicalData };
      
      logger.debug('CLIENTS', 'Procesando arrays médicos para encriptación', {
        clientId: id,
        arrayFields
      });

      arrayFields.forEach(field => {
        const arrayData = (processedMedicalData as any)[field];
        (processedMedicalData as any)[field] = processAndEncryptArray(field, arrayData);
      });

      // ✅ Procesar profilePhoto para encriptación (usando encryptFileObject)
      const processedPersonalData = { ...data.personalData };
      if (processedPersonalData.profilePhoto && typeof processedPersonalData.profilePhoto === 'object') {
        processedPersonalData.profilePhoto = encryptFileObject(processedPersonalData.profilePhoto);
        logger.debug('CLIENTS', 'ProfilePhoto procesado y encriptado', { clientId: id });
      }

      // ✅ Procesar documents para encriptación (usando encryptFileObject en cada documento)
      if (processedMedicalData.documents && Array.isArray(processedMedicalData.documents)) {
        processedMedicalData.documents = processedMedicalData.documents.map((doc: any) => 
          encryptFileObject(doc)
        );
        logger.debug('CLIENTS', 'Documents procesado y encriptado', {
          clientId: id,
          documentCount: processedMedicalData.documents.length
        });
      } else {
        processedMedicalData.documents = [];
      }

      // Encriptar datos personales y médicos
      logger.debug('ENCRYPTION', 'Encriptando datos personales y médicos', { clientId: id });
      
      const encryptedPersonalData = encryptObjectData(processedPersonalData);
      const encryptedMedicalData = encryptObjectData(processedMedicalData);

      const updateData = {
        personalData: encryptedPersonalData,
        medicalData: encryptedMedicalData,
        // SEC-ROBUSTEZ: default false si el body no trae contractAccepted
        // (antes: data.contractAccepted.toString() lanzaba TypeError → 500)
        contractAccepted: encrypt((data.contractAccepted ?? false).toString()),
        // Registrar versión y fecha de aceptación del contrato si se reacepta
        ...(data.contractVersion && { contractVersion: data.contractVersion }),
        ...(data.contractAccepted && { contractAcceptedAt: new Date() }),
        updatedAt: new Date()
      };

      // Logs de verificación
      logger.debug('ENCRYPTION', 'Datos encriptados', {
        clientId: id,
        hasProfilePhoto: !!encryptedPersonalData.profilePhoto,
        profilePhotoType: typeof encryptedPersonalData.profilePhoto,
        hasDocuments: !!encryptedMedicalData.documents,
        documentsIsArray: Array.isArray(encryptedMedicalData.documents),
        documentsLength: Array.isArray(encryptedMedicalData.documents) ? 
          encryptedMedicalData.documents.length : 'N/A'
      });

      logger.debug('CLIENTS', 'Ejecutando actualización en base de datos', { clientId: id });

      const result = await healthForms.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData }
      );

      logger.debug('CLIENTS', 'Resultado de la actualización', {
        clientId: id,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      });

      if (result.matchedCount === 0) {
        logger.warn('CLIENTS', 'Cliente no encontrado para actualización', undefined, { clientId: id });
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado', code: 'NOT_FOUND'},
          { status: 404 }
        );
      }

      logger.info('CLIENTS', 'Cliente actualizado exitosamente', { clientId: id });

      logAuditEvent({
        eventType: 'CLIENT_UPDATED',
        severity: 'info',
        message: `Cliente actualizado: ${id}`,
        coachId: auth.coachId,
        ...reqCtx,
        path: `/api/clients/${id}`,
        method: 'PUT',
        statusCode: 200,
      });

      return NextResponse.json({
        success: true,
        message: 'Cliente actualizado exitosamente'
      });

    } catch (error: any) {
      logger.error('CLIENTS', 'Error actualizando cliente', error, {
        endpoint: `/api/clients/${(await params).id}`,
        method: 'PUT',
        clientId: (await params).id
      });
      
      if (error.message.includes('Token')) {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
          { status: 401 }
        );
      }

      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && { 
            error: error.message
          }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  }, { endpoint: `/api/clients/${(await params).id}`, clientId: (await params).id });
}

export const PUT = apiHandler(putHandler);

// DELETE: Eliminar cliente
async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return logger.time('CLIENTS', 'Eliminar cliente y archivos S3', async () => {
    try {
      const { id } = await params;
      
      logger.info('CLIENTS', 'Solicitud DELETE /api/clients/[id] recibida', undefined, {
        endpoint: `/api/clients/${id}`,
        method: 'DELETE',
        clientId: id
      });

      // Verificar autenticación + ownership
      let auth;
      try {
        auth = requireCoachAuth(request);
      } catch {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
          { status: 401 }
        );
      }

      // Request context para audit logs
      const reqCtx = {
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        requestId: request.headers.get('x-request-id') || undefined,
      };

      const healthForms = await getHealthFormsCollection();
      
      // Primero obtener el cliente para extraer las claves de S3 y verificar ownership
      const client = await healthForms.findOne({ _id: new ObjectId(id) });

      if (!client) {
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado', code: 'NOT_FOUND'},
          { status: 404 }
        );
      }

      // Solo admin o coach dueño del cliente puede eliminar
      if (auth.role !== 'admin' && client.coachId !== auth.coachId) {
        logger.warn('CLIENTS', 'Intento de eliminar cliente no autorizado', {
          coachId: auth.coachId,
          clientId: id,
          clientCoachId: client.coachId,
        });
        return NextResponse.json(
          { success: false, message: 'No tienes permiso para eliminar este cliente', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }
      
      // Función para extraer claves S3 de los archivos del cliente
      const extractS3Keys = async (client: any): Promise<string[]> => {
        const keys: string[] = [];
        
        try {
          // Extraer profilePhoto key si existe
          if (client.personalData?.profilePhoto) {
            try {
              let profilePhoto = client.personalData.profilePhoto;
              
              // Si está encriptado como string, desencriptar y parsear
              if (typeof profilePhoto === 'string') {
                const decrypted = safeDecrypt(profilePhoto);
                profilePhoto = JSON.parse(decrypted);
                
                // Desencriptar campos internos si es necesario
                if (typeof profilePhoto === 'object' && profilePhoto !== null) {
                  const decryptedPhoto: any = {};
                  for (const [key, value] of Object.entries(profilePhoto)) {
                    if (typeof value === 'string') {
                      decryptedPhoto[key] = safeDecrypt(value);
                    } else {
                      decryptedPhoto[key] = value;
                    }
                  }
                  profilePhoto = decryptedPhoto;
                }
              }
              
              if (profilePhoto?.key) {
                keys.push(profilePhoto.key);
                logger.debug('CLIENTS', 'ProfilePhoto key encontrada', {
                  clientId: id,
                  key: profilePhoto.key
                });
              }
            } catch (error) {
              logger.error('CLIENTS', 'Error extrayendo profilePhoto key', error as Error, { clientId: id });
            }
          }

          // Extraer documents keys si existen
          if (client.medicalData?.documents) {
            try {
              let documents = client.medicalData.documents;
              
              // Si está encriptado como string, desencriptar y parsear
              if (typeof documents === 'string') {
                const decrypted = safeDecrypt(documents);
                documents = JSON.parse(decrypted);
              }
              
              if (Array.isArray(documents)) {
                documents.forEach((doc: any, index: number) => {
                  try {
                    // Si el documento es un string (encriptado), desencriptarlo
                    if (typeof doc === 'string') {
                      const decryptedDoc = safeDecrypt(doc);
                      doc = JSON.parse(decryptedDoc);
                    }
                    
                    // Desencriptar campos internos si es necesario
                    if (typeof doc === 'object' && doc !== null) {
                      const decryptedDoc: any = {};
                      for (const [key, value] of Object.entries(doc)) {
                        if (typeof value === 'string') {
                          decryptedDoc[key] = safeDecrypt(value);
                        } else {
                          decryptedDoc[key] = value;
                        }
                      }
                      doc = decryptedDoc;
                    }
                    
                    if (doc?.key) {
                      keys.push(doc.key);
                      logger.debug('CLIENTS', 'Document key encontrada', {
                        clientId: id,
                        documentIndex: index,
                        key: doc.key
                      });
                    }
                  } catch (docError) {
                    logger.error('CLIENTS', `Error procesando documento ${index}`, docError as Error, {
                      clientId: id,
                      documentIndex: index
                    });
                  }
                });
              }
            } catch (error) {
              logger.error('CLIENTS', 'Error extrayendo documents keys', error as Error, { clientId: id });
            }
          }
        } catch (error) {
          logger.error('CLIENTS', 'Error general extrayendo S3 keys', error as Error, { clientId: id });
        }
        
        return keys;
      };

      // Extraer todas las claves S3
      const s3Keys = await extractS3Keys(client);
      logger.info('CLIENTS', 'Claves S3 encontradas para eliminación', {
        clientId: id,
        totalKeys: s3Keys.length,
        keys: s3Keys
      });

      // Eliminar archivos de S3
      if (s3Keys.length > 0) {
        const deletePromises = s3Keys.map(async (key) => {
          try {
            await S3Service.deleteFile(key);
            logger.info('CLIENTS', 'Archivo S3 eliminado exitosamente', {
              clientId: id,
              key
            });
            return { key, success: true };
          } catch (error) {
            logger.error('CLIENTS', 'Error eliminando archivo S3', error as Error, {
              clientId: id,
              key
            });
            return { key, success: false, error: (error as Error).message };
          }
        });

        const deleteResults = await Promise.all(deletePromises);
        
        const successfulDeletes = deleteResults.filter(result => result.success).length;
        const failedDeletes = deleteResults.filter(result => !result.success).length;
        
        logger.info('CLIENTS', 'Resultado eliminación archivos S3', {
          clientId: id,
          successful: successfulDeletes,
          failed: failedDeletes,
          total: s3Keys.length
        });
      } else {
        logger.info('CLIENTS', 'No hay archivos S3 para eliminar', { clientId: id });
      }

      // Ahora eliminar el cliente de la base de datos
      logger.debug('CLIENTS', 'Ejecutando eliminación en base de datos', { clientId: id });
      const result = await healthForms.deleteOne({ _id: new ObjectId(id) });

      logger.debug('CLIENTS', 'Resultado de la eliminación', {
        clientId: id,
        deletedCount: result.deletedCount
      });

      if (result.deletedCount === 0) {
        logger.warn('CLIENTS', 'Cliente no encontrado para eliminación', undefined, { clientId: id });
        return NextResponse.json(
          { success: false, message: 'Cliente no encontrado', code: 'NOT_FOUND'},
          { status: 404 }
        );
      }

      logger.info('CLIENTS', 'Cliente y archivos eliminados exitosamente', { clientId: id });

      logAuditEvent({
        eventType: 'CLIENT_DELETED',
        severity: 'warning',
        message: `Cliente eliminado: ${id}`,
        coachId: auth.coachId,
        ...reqCtx,
        path: `/api/clients/${id}`,
        method: 'DELETE',
        statusCode: 200,
      });

      return NextResponse.json({
        success: true,
        message: 'Cliente y archivos asociados eliminados exitosamente'
      });

    } catch (error: any) {
      logger.error('CLIENTS', 'Error eliminando cliente', error, {
        endpoint: `/api/clients/${(await params).id}`,
        method: 'DELETE',
        clientId: (await params).id
      });
      
      if (error.message.includes('Token')) {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
          { status: 401 }
        );
      }

      return NextResponse.json(
        { 
          success: false, 
          message: 'Error interno del servidor',
          ...(process.env.NODE_ENV === 'development' && { 
            error: error.message
          }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  }, { endpoint: `/api/clients/${(await params).id}`, clientId: (await params).id });
}

export const DELETE = apiHandler(deleteHandler);