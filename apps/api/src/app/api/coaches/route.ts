import { NextRequest, NextResponse } from 'next/server';
import Coach from '@/app/models/Coach';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import { decrypt, safeDecrypt } from '@/app/lib/encryption';
import { connectMongoose, getHealthFormsCollection } from '@/app/lib/database';
import { apiHandler } from '@/app/lib/apiHandler';

function decryptPhoto(photo: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!photo || !photo.url) return null;
  const urlRaw = String(photo.url);
  const keyRaw = String(photo.key || '');
  const nameRaw = String(photo.name || '');
  const typeRaw = String(photo.type || '');
  return {
    url: decrypt(urlRaw),
    key: keyRaw ? decrypt(keyRaw) : keyRaw,
    name: nameRaw ? decrypt(nameRaw) : nameRaw,
    type: typeRaw ? decrypt(typeRaw) : typeRaw,
    size: Number(photo.size) || 0,
    uploadedAt: String(photo.uploadedAt || ''),
  };
}

async function getHandler(request: NextRequest) {
  try {
    await connectMongoose();
    const auth = requireCoachAuth(request);

    if (auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, message: 'Acceso denegado. Solo administradores.', code: 'FORBIDDEN'},
        { status: 403 }
      );
    }

    const coaches = await Coach.find({})
      .select('-passwordHash -verificationToken -resetToken -resetTokenExpiry -emailHash')
      .sort({ createdAt: -1 });

    // Contar clientes por coach para toda la lista en una sola query
    const healthFormsCollection = await getHealthFormsCollection();
    const clientCounts = await healthFormsCollection.aggregate<{ _id: string; count: number }>([
      { $match: { coachId: { $ne: null } } },
      { $group: { _id: '$coachId', count: { $sum: 1 } } },
    ]).toArray();
    const clientCountMap = new Map(clientCounts.map((r) => [r._id, r.count]));

    return NextResponse.json({
      success: true,
      data: coaches.map((c) => {
        const coachId = (c._id as { toString(): string }).toString();
        return {
          id: coachId,
          email: decrypt(c.email),
          firstName: decrypt(c.firstName),
          lastName: decrypt(c.lastName),
          phone: c.phone ? decrypt(c.phone) : '',
          professionalTitle: safeDecrypt(c.professionalTitle as string) || '',
          profilePhoto: decryptPhoto(c.profilePhoto as unknown as Record<string, unknown> | null),
          role: c.role,
          emailVerified: c.emailVerified,
          isActive: c.isActive,
          isSuspended: c.isSuspended || false,
          trialStatus: c.trialStatus || 'none',
          subscriptionStatus: c.subscriptionStatus || '',
          createdAt: c.createdAt,
          clientCount: clientCountMap.get(coachId) || 0,
          stripeConnect: {
            hasAccount: !!c.stripeConnectAccountId,
            onboardingComplete: c.stripeOnboardingComplete || false,
            payoutsEnabled: c.stripePayoutsEnabled || false,
          },
        };
      }),
    });
  } catch (error: unknown) {
    if ((error as Error).message?.includes('Token')) {
      return NextResponse.json({ success: false, message: 'No autorizado', code: 'UNAUTHORIZED'}, { status: 401 });
    }
    logger.error('AUTH', 'Error listando coaches', error instanceof Error ? error : new Error(String(error)));
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
