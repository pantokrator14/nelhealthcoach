// apps/api/src/app/api/payments/finances/route.ts
// Devuelve datos financieros del coach autenticado.
// - Admin: ve ingresos de sesiones (precio fijo $150) + ingresos por suscripciones de coaches
// - Coach normal: ve ingresos (su precio), costo suscripción, neto

import { NextRequest, NextResponse } from 'next/server';
import { connectMongoose } from '@/app/lib/database';
import { requireCoachAuth } from '@/app/lib/auth';
import { logger } from '@/app/lib/logger';
import PendingSession from '@/app/models/PendingSession';
import Coach from '@/app/models/Coach';
import SubscriptionPayment from '@/app/models/SubscriptionPayment';
import StripePayout from '@/app/models/StripePayout';
import { decrypt } from '@/app/lib/encryption';
import { stripeClient } from '@/app/lib/stripe';
import { apiHandler } from '@/app/lib/apiHandler';

/**
 * GET /api/payments/finances?period=6m|12m|all
 */
async function getHandler(request: NextRequest) {
  try {
    await connectMongoose();
    let auth;
    try {
      auth = requireCoachAuth(request);
    } catch {
      return NextResponse.json(
        { success: false, message: 'No autorizado', code: 'UNAUTHORIZED'},
        { status: 401 }
      );
    }
    const coachId = auth.coachId;
    const isAdmin = auth.role === 'admin';

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '12m';

    // Calcular fecha de inicio según el período
    const now = new Date();
    let startDate: Date | null = null;
    if (period === '6m') {
      startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    } else if (period === '12m') {
      startDate = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    }

    // ─── Obtener coach ───
    const coach = await Coach.findById(coachId).lean() as Record<string, unknown> | null;
    if (!coach) {
      return NextResponse.json({ success: false, message: 'Coach no encontrado', code: 'NOT_FOUND'}, { status: 404 });
    }

    // ─── Precio por sesión ───
    const defaultAmountCents = (Number(process.env.CLIENT_SESSION_AMOUNT) || 150) * 100;
    // Admin: siempre usa el precio fijo del sistema. Coach normal: usa su precio configurado.
    const sesionPrice = isAdmin ? defaultAmountCents : (coach.sessionPrice as number) || defaultAmountCents;

    // ─── 1. Ingresos por sesiones (PendingSession) ───
    const sessionFilter: Record<string, unknown> = {
      coachId,
      status: { $in: ['paid', 'completed'] },
    };
    if (startDate) {
      sessionFilter.paymentConfirmedAt = { $gte: startDate };
    }

    const paidSessions = await PendingSession.find(sessionFilter)
      .sort({ paymentConfirmedAt: -1 })
      .lean()
      .exec() as Array<Record<string, unknown>>;

    const totalBruto = paidSessions.length * sesionPrice;

    // ─── 2. Transacciones recientes ───
    const transaccionesRecientes = paidSessions.slice(0, 20).map((s) => ({
      id: String(s._id),
      clientName: (s.clientName as string) || 'Cliente',
      amount: sesionPrice,
      date: (s.paymentConfirmedAt as Date)?.toISOString() || (s.createdAt as Date)?.toISOString(),
      status: s.status as string,
    }));

    // ─── 3. Suscripción ───
    // Para coach normal: es un gasto (paga $150/mes)
    // Para admin: es un ingreso (recibe $150/mes de cada coach)
    let totalSuscripcion = 0;
    let monthsSubscribed = 0;
    let nextBillingDate: string | null = null;
    let subscriptionStatus = 'inactive';
    let subscriptionPayments: Array<Record<string, unknown>> = [];
    const coachSubscriptionAmount = Number(process.env.COACH_SUBSCRIPTION_AMOUNT) || 150;
    let suscripcionData = null;

    // ── Consultar SubscriptionPayment ──
    // Admin: ve pagos de TODOS los coaches. Coach normal: solo los suyos.
    const subFilter: Record<string, unknown> = isAdmin ? {} : { coachId };
    if (startDate) {
      subFilter.paidAt = { $gte: startDate };
    }

    subscriptionPayments = await SubscriptionPayment.find(subFilter)
      .sort({ paidAt: -1 })
      .lean()
      .exec() as Array<Record<string, unknown>>;

    totalSuscripcion = subscriptionPayments.reduce(
      (sum, sp) => sum + ((sp.amount as number) || 0),
      0
    );
    monthsSubscribed = subscriptionPayments.length;

    if (!isAdmin) {
      // ── Coach normal: estado, fechas, Stripe ──
      subscriptionStatus = (coach.subscriptionStatus as string) || 'inactive';

      // Fallback: consultar Stripe API si no hay historial local
      if (subscriptionPayments.length === 0 && coach.stripeCustomerId) {
        try {
          const customerId = decrypt(coach.stripeCustomerId as string);
          if (customerId && customerId.startsWith('cus_')) {
            const invoices = await stripeClient.invoices.list({
              customer: customerId,
              limit: 24,
              status: 'paid',
            });

            const fallbackPayments = invoices.data.map((inv) => ({
              amount: (inv.amount_paid as unknown as number) || 0,
              paidAt: new Date((inv.status_transitions as unknown as Record<string, string>)?.paid_at || Date.now()),
              invoiceId: inv.id as string,
            })) as unknown as Array<Record<string, unknown>>;

            for (const sp of fallbackPayments) {
              try {
                await SubscriptionPayment.create({
                  coachId,
                  amount: sp.amount,
                  invoiceId: sp.invoiceId,
                  subscriptionId: (coach.subscriptionId as string) || '',
                  customerId,
                  paidAt: sp.paidAt,
                });
              } catch {
                // Duplicado, ignorar
              }
            }

            subscriptionPayments = await SubscriptionPayment.find(subFilter)
              .sort({ paidAt: -1 })
              .lean()
              .exec() as Array<Record<string, unknown>>;

            totalSuscripcion = subscriptionPayments.reduce(
              (sum, sp) => sum + ((sp.amount as number) || 0),
              0
            );
            monthsSubscribed = subscriptionPayments.length;
          }
        } catch (stripeError) {
          logger.error('FINANCES', 'Error consultando Stripe API para historial de suscripción', stripeError as Error);
        }
      }

      // Próximo cobro
      if (subscriptionPayments.length > 0) {
        const lastPayment = subscriptionPayments[0];
        const lastPaid = new Date(lastPayment.paidAt as string);
        const nextDate = new Date(lastPaid);
        nextDate.setMonth(nextDate.getMonth() + 1);
        nextBillingDate = nextDate.toISOString();
      } else if (coach.trialEndDate) {
        nextBillingDate = new Date(coach.trialEndDate as string).toISOString();
      }

      // Obtener info de suscripción desde Stripe
      const coachSubId = coach.subscriptionId as string | undefined;
      let subscriptionFromStripe: Record<string, unknown> | null = null;
      if (coachSubId && coach.stripeCustomerId) {
        try {
          const customerId = decrypt(coach.stripeCustomerId as string);
          if (customerId.startsWith('cus_')) {
            subscriptionFromStripe = await stripeClient.subscriptions.retrieve(
              coachSubId
            ) as unknown as Record<string, unknown>;
          }
        } catch {
          // Ignorar
        }
      }

      suscripcionData = {
        status: subscriptionStatus,
        monto: coachSubscriptionAmount * 100,
        proximoCobro: nextBillingDate,
        mesesSuscrito: monthsSubscribed,
        currentPeriodEnd: subscriptionFromStripe?.current_period_end
          ? new Date((subscriptionFromStripe.current_period_end as number) * 1000).toISOString()
          : nextBillingDate,
      };
    } else {
      // ── Admin: datos de ingresos por suscripciones ──
      suscripcionData = {
        status: 'active',
        monto: coachSubscriptionAmount * 100,
        proximoCobro: null,
        mesesSuscrito: monthsSubscribed,
        currentPeriodEnd: null,
      };
    }

    // ─── 4. Retiros a cuenta bancaria (payouts) ───
    // Admin: payouts de la cuenta principal de Stripe
    // Coach normal: payouts de su cuenta de Stripe Connect
    let payouts: Array<Record<string, unknown>> = [];
    let totalPayoutsCents = 0;

    try {
      if (isAdmin) {
        // ── Admin: sincronizar payouts desde API de Stripe ──
        const stripePayouts = await stripeClient.payouts.list({ limit: 100 });

        for (const po of stripePayouts.data) {
          try {
            await StripePayout.updateOne(
              { payoutId: po.id },
              {
                $set: {
                  payoutId: po.id,
                  amount: po.amount,
                  currency: po.currency,
                  status: po.status,
                  arrivalDate: new Date((po.arrival_date as number) * 1000),
                  created: new Date((po.created as number) * 1000),
                  description: po.description || '',
                  bankAccount: (po.destination as string) || '',
                  failureMessage: po.failure_message || '',
                },
              },
              { upsert: true }
            );
          } catch {
            // Ignorar duplicados
          }
        }
      } else {
        // ── Coach normal: sincronizar payouts desde su Connect account ──
        const connectAccountId = coach.stripeConnectAccountId as string | undefined;
        if (connectAccountId && (coach.stripePayoutsEnabled as boolean)) {
          const connectPayouts = await stripeClient.payouts.list(
            { limit: 100 },
            { stripeAccount: connectAccountId } as Record<string, unknown>
          );

          for (const po of connectPayouts.data) {
            try {
              await StripePayout.updateOne(
                { payoutId: po.id },
                {
                  $set: {
                    payoutId: po.id,
                    coachId,
                    amount: po.amount,
                    currency: po.currency,
                    status: po.status,
                    arrivalDate: new Date((po.arrival_date as number) * 1000),
                    created: new Date((po.created as number) * 1000),
                    description: po.description || '',
                    bankAccount: (po.destination as string) || '',
                    failureMessage: po.failure_message || '',
                  },
                },
                { upsert: true }
              );
            } catch {
              // Ignorar duplicados
            }
          }
        }
      }

      // Consultar desde la colección local
      const payoutFilter: Record<string, unknown> = {};
      if (!isAdmin) {
        payoutFilter.coachId = coachId;
      }
      // Admin: sin coachId (solo payouts de la cuenta principal)
      if (startDate) {
        payoutFilter.arrivalDate = { $gte: startDate };
      }

      const localPayouts = await StripePayout.find(payoutFilter)
        .sort({ arrivalDate: -1 })
        .lean()
        .exec() as Array<Record<string, unknown>>;

      payouts = localPayouts.map((po) => ({
        id: po.payoutId as string,
        amount: po.amount as number,
        status: po.status as string,
        arrivalDate: (po.arrivalDate as Date)?.toISOString(),
        description: (po.description as string) || 'Retiro a cuenta bancaria',
      }));

      totalPayoutsCents = localPayouts.reduce(
        (sum, po) => sum + ((po.amount as number) || 0),
        0
      );
    } catch (stripeError) {
      logger.error('FINANCES', 'Error sincronizando payouts desde Stripe', stripeError as Error);
    }

    // ─── 5. Breakdown mensual ───
    const breakdownMap = new Map<string, { ingresos: number; suscripcion: number }>();
    const monthsToShow = period === '6m' ? 6 : period === 'all' ? 24 : 12;
    for (let i = monthsToShow - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      breakdownMap.set(key, { ingresos: 0, suscripcion: 0 });
    }

    for (const s of paidSessions) {
      const d = s.paymentConfirmedAt
        ? new Date(s.paymentConfirmedAt as string)
        : new Date(s.createdAt as string);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (breakdownMap.has(key)) {
        breakdownMap.get(key)!.ingresos += sesionPrice;
      }
    }

    for (const sp of subscriptionPayments) {
      const d = new Date(sp.paidAt as string);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (breakdownMap.has(key)) {
        breakdownMap.get(key)!.suscripcion += (sp.amount as number) || 0;
      }
    }

    const breakdownMensual = Array.from(breakdownMap.entries()).map(([month, data]) => ({
      month,
      ingresos: data.ingresos,
      suscripcion: data.suscripcion,
    }));

    // ─── 6. Response ───
    // Admin: total = sesiones + suscripciones (ambos son ingreso)
    // Coach: total = sesiones - suscripción (gasto)
    const totalObtenido = isAdmin
      ? totalBruto + totalSuscripcion
      : Math.max(0, totalBruto - totalSuscripcion);

    return NextResponse.json({
      success: true,
      data: {
        isAdmin,
        summary: {
          totalBruto,
          totalSuscripcion,
          totalObtenido,
          totalPayouts: isAdmin ? totalPayoutsCents : 0,
          sesionesCompletadas: paidSessions.length,
        },
        sesionPrice,
        sesionPriceFijo: isAdmin, // true = no editable
        transaccionesRecientes,
        breakdownMensual,
        suscripcion: suscripcionData,
        payouts,
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
    logger.error('FINANCES', 'Error obteniendo datos financieros', error as Error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Error al obtener datos financieros',
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
      { status: 500 }
    );
  }
}

export const GET = apiHandler(getHandler);
