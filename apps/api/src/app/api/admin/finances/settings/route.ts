// apps/api/src/app/api/admin/finances/settings/route.ts
// Configuración fiscal de NELHEALTHCOACH, LLC (singleton)

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { apiHandler } from '@/app/lib/apiHandler';
import { logger } from '@/app/lib/logger';
import { encrypt } from '@/app/lib/encryption';
import BusinessSettings from '@/app/models/BusinessSettings';

function requireAdmin(request: NextRequest): void {
  const auth = requireCoachAuth(request);
  if (auth.role !== 'admin') {
    throw Object.assign(new Error('Solo el administrador puede acceder a esta sección'), { status: 403 });
  }
}

// ─── GET: Obtener configuración ───

async function getHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    let settings = await BusinessSettings.findOne().lean().exec();

    if (!settings) {
      // Crear configuración por defecto
      const encryptedEIN = encrypt('XX-XXXXXXX'); // placeholder
      settings = await BusinessSettings.create({
        companyName: 'NELHEALTHCOACH, LLC',
        ein: encryptedEIN,
        state: 'California',
        entityType: 'LLC',
        accountingMethod: 'cash',
        fiscalYearStart: '01-01',
        californiaLLC: {
          annualFee: 800,
          annualFeePaid: false,
        },
      }).then(doc => doc.toObject());
    }

    // No devolver el EIN encriptado, sino un indicador
    const { ein, ...safeSettings } = settings as Record<string, unknown>;

    return NextResponse.json({
      success: true,
      data: {
        ...safeSettings,
        hasEIN: typeof ein === 'string' && ein.length > 0 && ein !== 'XX-XXXXXXX',
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
    logger.error('FINANCES', 'Error obteniendo configuración fiscal', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al obtener configuración fiscal',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

// ─── PUT: Actualizar configuración ───

async function putHandler(request: NextRequest) {
  try {
    requireAdmin(request);
    await connectMongoose();

    const body = (await request.json()) as Record<string, unknown>;

    const allowedFields = [
      'companyName', 'ein', 'state', 'entityType',
      'accountingMethod', 'fiscalYearStart', 'naicsCode',
      'registeredAgent', 'californiaLLC',
    ];

    const updates: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (field === 'ein' && typeof body.ein === 'string') {
          updates.ein = encrypt(body.ein);
        } else if (field === 'accountingMethod') {
          if (body.accountingMethod === 'cash' || body.accountingMethod === 'accrual') {
            updates.accountingMethod = body.accountingMethod;
          }
        } else if (field === 'californiaLLC') {
          const llc = body.californiaLLC as Record<string, unknown>;
          if (typeof llc === 'object' && llc !== null) {
            updates.californiaLLC = {
              fileNumber: llc.fileNumber || undefined,
              annualFee: typeof llc.annualFee === 'number' ? llc.annualFee : 800,
              annualFeePaid: llc.annualFeePaid === true,
              lastFeeDate: llc.lastFeeDate ? new Date(llc.lastFeeDate as string) : undefined,
            };
          }
        } else if (typeof body[field] === 'string') {
          updates[field] = body[field];
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { success: false, message: 'No hay campos válidos para actualizar', code: 'VALIDATION'},
        { status: 400 }
      );
    }

    const existing = await BusinessSettings.findOne();
    if (!existing) {
      // Crear con valores por defecto + updates
      const encryptedEIN = encrypt(body.ein as string || 'XX-XXXXXXX');
      await BusinessSettings.create({
        companyName: 'NELHEALTHCOACH, LLC',
        ein: encryptedEIN,
        state: 'California',
        entityType: 'LLC',
        accountingMethod: 'cash',
        fiscalYearStart: '01-01',
        ...updates,
      });
    } else {
      await BusinessSettings.findByIdAndUpdate(existing._id, {
        $set: updates,
      }).exec();
    }

    const updated = await BusinessSettings.findOne().lean().exec();

    logger.info('FINANCES', 'Configuración fiscal actualizada');

    const { ein, ...safeSettings } = (updated || {}) as Record<string, unknown>;

    return NextResponse.json({
      success: true,
      data: {
        ...safeSettings,
        hasEIN: typeof ein === 'string' && ein.length > 0 && ein !== 'XX-XXXXXXX',
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
    logger.error('FINANCES', 'Error actualizando configuración fiscal', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al actualizar configuración fiscal',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);
export const PUT = apiHandler(putHandler);
