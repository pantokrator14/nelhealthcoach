// apps/dashboard/src/lib/aiVisibleText.ts
// Sanitización de textos visibles al usuario: los nombres de los proveedores
// de IA (Gemini, DeepSeek) NO deben aparecer en ninguna parte de la interfaz.

/**
 * Limpia nombres de proveedores de IA en mensajes de error que provienen
 * del backend (o de respuestas cacheadas) antes de mostrarlos en la UI.
 */
export const sanitizeProviderName = (message: string): string =>
  message
    .replace(/GEMINI_API_KEY|DEEPSEEK_API_KEY/gi, 'la API Key del servicio de IA')
    .replace(/GEMINI_MODEL|DEEPSEEK_MODEL/gi, 'el modelo de IA')
    .replace(/Gemini|DeepSeek/g, 'IA');

/**
 * Versión segura para toasts/alerias: devuelve cadena vacía si el valor
 * no es texto (protección ante datos inesperados del backend).
 */
export const sanitizeProviderText = (message: unknown): string => {
  if (typeof message !== 'string' || message.length === 0) return '';
  return sanitizeProviderName(message);
};
/**
 * Localiza errores de generación conocidos del backend.
 * El backend genera mensajes TÉCNICOS en español ("Fase 1 fallida: El LLM no
 * devolvió un JSON parseable..."). Para la UI, se mapean a mensajes amigables
 * en el idioma activo. Si el error no es reconocido, se devuelve un mensaje
 * genérico localizado (nunca el detalle técnico crudo).
 */
type TFunction = (key: string) => string;

export const translateGenerationError = (
  message: string,
  t: TFunction
): string => {
  const m = message.toLowerCase();

  // FASE 1/2/3: el LLM devolvió vacío o JSON no parseable (modelo reasoner
  // que agotó el presupuesto de tokens razonando — fallo transitorio)
  if (/fase 1|fase 2|fase 3/.test(m) && /json|parseable|vac[ií]o|0 chars/.test(m)) {
    return t('ai.generationErrorLlmEmpty');
  }
  // El modelo no extrajo las tablas de biomarcadores
  if (/no extrajo las tablas|biomarcadores/.test(m)) {
    return t('ai.generationErrorMedicalTables');
  }
  // Documento no analizado (503/404 del proveedor)
  if (/fall[oó] el an[aá]lisis de|documento sin an[aá]lisis/.test(m)) {
    return t('ai.generationErrorDocument');
  }
  // Sesión no está en draft (regen)
  if (/solo se pueden regenerar sesiones en estado/.test(m)) {
    return t('ai.generationErrorNotDraft');
  }
  // DeepSeek devolvió respuesta vacía (análisis de documento)
  if (/respuesta vac[ií]a|deepseek devolvi[oó] respuesta/.test(m)) {
    return t('ai.generationErrorLlmEmpty');
  }
  // Timeout de conexión con MongoDB
  if (/server selection timed out|mongodb/.test(m)) {
    return t('ai.generationErrorDbTimeout');
  }

  // Desconocido → mensaje genérico (sin exponer detalle técnico)
  return t('ai.generationErrorGeneric');
};
