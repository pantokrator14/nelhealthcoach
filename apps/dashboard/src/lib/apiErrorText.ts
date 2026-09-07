import type { TFunction } from 'i18next';

// Acepta tanto TFunction de i18next como wrappers simples (key) => string.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Traductor de errores de API para UI (toasts / mensajes en línea).
 *
 * Regla de oro: el `message` crudo del backend (español técnico) NUNCA se
 * muestra al usuario final. En su lugar:
 *
 *   1. Si el error trae `code` (convención `{ success: false, message, code }`
 *      de la API) y el código está en CODE_TO_KEY → se muestra la key i18n
 *      correspondiente (bloque `apiErrors`, 6 idiomas).
 *   2. Si no trae código → se muestra el fallback localizado del flujo
 *      (p.ej. `exercises.errorDeleting`), que cada llamada debe proveer.
 *   3. Último recurso → `common.error`.
 *
 * Todo mensaje de error visible se completa con el aviso de contacto a
 * Soporte (common.contactSupport). El detalle técnico siempre queda en
 * consola para debugging.
 */

const CODE_TO_KEY: Record<string, string> = {
  UNAUTHORIZED: 'apiErrors.unauthorized',
  FORBIDDEN: 'apiErrors.forbidden',
  NOT_FOUND: 'apiErrors.notFound',
  SESSION_NOT_FOUND: 'apiErrors.notFound',
  VALIDATION: 'apiErrors.validation',
  INVALID_PASSWORD: 'apiErrors.invalidPassword',
  EMAIL_NOT_VERIFIED: 'apiErrors.emailNotVerified',
  SESSION_NOT_DRAFT: 'apiErrors.sessionNotDraft',
  CONFLICT: 'apiErrors.conflict',
  RATE_LIMITED: 'apiErrors.rateLimited',
  TRIAL_ALREADY_USED: 'apiErrors.trialAlreadyUsed',
  INTERNAL: 'apiErrors.internal',
};

export function apiErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown } | null;
  return typeof e?.code === 'string' && e.code.length > 0 ? e.code : undefined;
}

/**
 * Agrega el aviso de Soporte al final de un mensaje de error localizado
 * (si el mensaje no lo incluye ya). Usar en toasts/banners de error.
 */
export function withSupportHint(message: string, t: TranslateFn): string {
  if (!message || message.includes('support@nelhealthcoach.com')) return message;
  return `${message} ${t('common.contactSupport')}`;
}

export function translateApiError(
  err: unknown,
  t: TranslateFn,
  fallbackKey?: string
): string {
  const code = apiErrorCode(err);
  let message: string;

  if (code) {
    if (CODE_TO_KEY[code]) {
      message = t(CODE_TO_KEY[code]);
    } else {
      console.error(`[apiError] código sin traducción registrada: ${code}`, err);
      message = fallbackKey ? t(fallbackKey) : t('common.error');
    }
  } else {
    // Sin código: el backend aún no migró este endpoint. Log para migrarlo.
    console.error('[apiError] respuesta sin code (migrar a códigos):', err);
    message = fallbackKey ? t(fallbackKey) : t('common.error');
  }

  return withSupportHint(message, t);
}
