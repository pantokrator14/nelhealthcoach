// apps/api/src/app/api/debug-medical/route.ts
// PROTEGIDO: Solo accesible en desarrollo o por administradores
import { NextRequest, NextResponse } from 'next/server';
import { getHealthFormsCollection } from '@/app/lib/database';
import { ObjectId } from 'mongodb';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';

async function getHandler(request: NextRequest) {
  try {
    // Solo admin en producción, o cualquier coach en desarrollo
    if (process.env.NODE_ENV === 'production') {
      const auth = requireCoachAuth(request);
      if (auth.role !== 'admin') {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    const healthForms = await getHealthFormsCollection();
    const client = id ? await healthForms.findOne({ _id: new ObjectId(id) }) : await healthForms.findOne({});
    
    if (!client) {
      return NextResponse.json({ error: 'No hay clientes' });
    }

    // Mostrar datos médicos en crudo
    const medicalData = client.medicalData || {};
    const arrayFields = [
      'carbohydrateAddiction', 'leptinResistance', 'circadianRhythms',
      'sleepHygiene', 'electrosmogExposure', 'generalToxicity', 'microbiotaHealth'
    ];

    const medicalDebug: any = {};
    
    arrayFields.forEach(field => {
      const fieldData = medicalData[field];
      medicalDebug[field] = {
        type: typeof fieldData,
        value: fieldData,
        length: typeof fieldData === 'string' ? fieldData.length : 'N/A',
        isArray: Array.isArray(fieldData)
      };
    });

    return NextResponse.json({
      clientId: client._id.toString(),
      medicalData: medicalDebug,
      rawMedicalData: medicalData
    });
  } catch (error: any) {
    return NextResponse.json({ 
      error: 'Error obteniendo datos médicos',
      ...(process.env.NODE_ENV === 'development' && { detail: (error as Error).message })
    });
  }
}

export const GET = apiHandler(getHandler);