import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseMessage, AIMessageChunk } from "@langchain/core/messages";
import { logger } from "../../logger";
import { extractTextFromBuffer } from "../../document-extractor";
import type { ExtractionResult } from "../../document-extractor";

// ─────────────────────────────────────────────
// Configuración centralizada de proveedores LLM
// ─────────────────────────────────────────────

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_REST_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1"; // OpenAI-compatible endpoint

type LLMProvider = "gemini" | "deepseek";

interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  /** Proveedor LLM. Default: gemini */
  provider?: LLMProvider;
}

/** Devuelve el modelo configurado para el proveedor indicado (con log) */
function resolveModel(provider: LLMProvider = "gemini"): string {
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL;
  }
  return process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
}

/** Devuelve la API key para el proveedor indicado */
function resolveApiKey(provider: LLMProvider): string {
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_API_KEY || "";
  }
  return process.env.GEMINI_API_KEY || "";
}

/** Devuelve la base URL para el proveedor indicado */
function resolveBaseURL(provider: LLMProvider): string {
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL;
  }
  return GEMINI_BASE_URL;
}

// ─────────────────────────────────────────────
// Fabrica principal
// ─────────────────────────────────────────────

function createLLM(options: LLMOptions = {}): ChatOpenAI {
  const provider: LLMProvider = options.provider ?? "gemini";
  const apiKey = resolveApiKey(provider);

  if (!apiKey) {
    const envVar = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "GEMINI_API_KEY";
    logger.error("AI", `${envVar} no configurada. Todas las llamadas a ${provider} fallarán.`);
    throw new Error(`${envVar} is required`);
  }

  const model = options.model ?? resolveModel(provider);
  const baseURL = resolveBaseURL(provider);

  logger.info("AI", `Creando instancia LLM ${provider}`, {
    model,
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? 8000,
    endpoint: baseURL,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ChatOpenAI({
    modelName: model,
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? 8000,
    streaming: options.streaming ?? false,
    apiKey,
    configuration: { baseURL },
  }) as any;
}

/**
 * Crea un LLM con fallback automático entre proveedores.
 *
 * Estrategia:
 *   1. Intenta con el provider primario (default: deepseek)
 *   2. Si falla y hay fallback disponible → intenta con el secundario (gemini)
 *   3. Logging claro de qué proveedor respondió
 */
export async function createLLMWithFallback(
  options: LLMOptions = {}
): Promise<ChatOpenAI> {
  const primaryProvider: LLMProvider = options.provider ?? "deepseek";
  const fallbackProvider: LLMProvider = primaryProvider === "deepseek" ? "gemini" : "deepseek";
  const logCtx = logger.withContext({ feature: "llm-fallback" });

  // Variables para capturar errores de ambos providers
  let primaryMsg = "";

  // 1. Intentar con el provider primario
  try {
    const llm = createLLM({ ...options, provider: primaryProvider });
    logCtx.info("AI", `LLM creado con provider primario: ${primaryProvider}`, {
      model: resolveModel(primaryProvider),
    });
    return llm;
  } catch (primaryError) {
    primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    logCtx.warn("AI", `Provider primario ${primaryProvider} no disponible, intentando fallback a ${fallbackProvider}`, {
      error: primaryMsg.substring(0, 200),
    });
  }

  // 2. Fallback al provider secundario
  try {
    const llm = createLLM({ ...options, provider: fallbackProvider });
    logCtx.info("AI", `LLM creado con provider fallback: ${fallbackProvider}`, {
      model: resolveModel(fallbackProvider),
    });
    return llm;
  } catch (fallbackError) {
    const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    logCtx.error("AI", `Ambos providers fallaron (${primaryProvider} → ${fallbackProvider})`, undefined, {
      primaryError: primaryMsg.substring(0, 200),
      fallbackError: fallbackMsg.substring(0, 200),
    });
    throw new Error(
      `Todos los proveedores LLM fallaron. Primario: ${primaryProvider}, Fallback: ${fallbackProvider}. ` +
      `Error fallback: ${fallbackMsg}`
    );
  }
}

// ─────────────────────────────────────────────
// Variantes preconfiguradas
// ─────────────────────────────────────────────

/**
 * Crea un LLM que intenta DeepSeek primero, y si falla, Gemini.
 * Sincrónico — se usa para instancias que no requieren async.
 */
export function createDeepSeekLLM(options: LLMOptions = {}): BaseChatModel {
  try {
    return createLLM({ ...options, provider: "deepseek" }) as unknown as BaseChatModel;
  } catch {
    logger.warn("AI", "createDeepSeekLLM: DeepSeek no disponible, usando Gemini");
    return createLLM({ ...options, provider: "gemini" }) as unknown as BaseChatModel;
  }
}

/**
 * Crea un LLM con fallback (Gemini → DeepSeek real).
 * Es async porque internamente usa createLLMWithFallback.
 * @param options.maxTokens Presupuesto de salida de ESTA llamada. Cada fase del
 *        pipeline puede pasar su propio valor (el modelo deepseek razona y el
 *        razonamiento consume del maxTokens — ver FASE 2/3 cortadas con
 *        finish_reason='length').
 */
export async function createDeepSeekJSONLLM(options: { maxTokens?: number } = {}): Promise<BaseChatModel> {
  const llm = await createLLMWithFallback({ temperature: 0.3, maxTokens: options.maxTokens ?? 16000 });
  return llm as unknown as BaseChatModel;
}

export function createDeepSeekAnalyticalLLM(options: LLMOptions = {}): BaseChatModel {
  try {
    return createLLM({ ...options, provider: "deepseek", temperature: 0.8, maxTokens: 3000 }) as unknown as BaseChatModel;
  } catch {
    logger.warn("AI", "createDeepSeekAnalyticalLLM: DeepSeek no disponible, usando Gemini");
    return createLLM({ ...options, provider: "gemini", temperature: 0.8, maxTokens: 3000 }) as unknown as BaseChatModel;
  }
}

export function createDeepSeekWithTools(
  tools: StructuredToolInterface[],
  options: LLMOptions = {}
): BaseChatModel {
  const llm = createDeepSeekLLM({
    temperature: options.temperature ?? 0.5,
    maxTokens: options.maxTokens ?? 6000,
  });

  const bound = (llm as unknown as Record<string, unknown>).bindTools as
    | ((t: StructuredToolInterface[]) => unknown)
    | undefined;
  if (!bound) {
    logger.error("AI", "bindTools no disponible en Gemini. Verifica compatibilidad del endpoint OpenAI.", {
      model: resolveModel(),
    });
    throw new Error("bindTools is not available on this model — Gemini OpenAI compat endpoint may not support function calling");
  }

  logger.debug("AI", "Tools bindeadas a LLM Gemini", { toolCount: tools.length });
  return bound.call(llm, tools) as unknown as BaseChatModel;
}

// ─────────────────────────────────────────────
// Aliases explícitos
// ─────────────────────────────────────────────

export function createGeminiLLM(options: LLMOptions = {}): BaseChatModel {
  try {
    return createLLM({ ...options, provider: "gemini" }) as unknown as BaseChatModel;
  } catch {
    logger.warn("AI", "createGeminiLLM: Gemini no disponible, usando DeepSeek real");
    return createLLM({ ...options, provider: "deepseek" }) as unknown as BaseChatModel;
  }
}

export async function createGeminiJSONLLM(): Promise<BaseChatModel> {
  return createDeepSeekJSONLLM();
}

export function createGeminiWithTools(
  tools: StructuredToolInterface[],
  options: LLMOptions = {}
): BaseChatModel {
  return createDeepSeekWithTools(tools, options);
}

// ─────────────────────────────────────────────
// JSON parsing y tool invocation
// ─────────────────────────────────────────────

export function robustJsonParse<T>(raw: string): T {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed) as T; } catch { /* continuar */ }
  const jsonBlock = trimmed.match(/```(?:json)?\s*[\n\r]([\s\S]*?)\n?\s*```/);
  if (jsonBlock) try { return JSON.parse(jsonBlock[1].trim()) as T; } catch { /* continuar */ }
  const anyBlock = trimmed.match(/```\s*[\n\r]([\s\S]*?)\n?\s*```/);
  if (anyBlock) try { return JSON.parse(anyBlock[1].trim()) as T; } catch { /* continuar */ }
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0;
    let start = -1;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{") { if (depth === 0) start = i; depth++; }
      else if (ch === "}") { depth--; if (depth === 0 && start !== -1) {
        try { return JSON.parse(trimmed.slice(start, i + 1)) as T; } catch { start = -1; }
      }}
    }
  }
  const firstBracket = trimmed.indexOf("[");
  if (firstBracket !== -1) {
    let depth = 0;
    let start = -1;
    for (let i = firstBracket; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "[") { if (depth === 0) start = i; depth++; }
      else if (ch === "]") { depth--; if (depth === 0 && start !== -1) {
        try { return JSON.parse(trimmed.slice(start, i + 1)) as T; } catch { start = -1; }
      }}
    }
  }
  throw new Error(`Failed to parse JSON from response (${raw.length} chars). First 200: ${raw.substring(0, 200)}`);
}

export async function invokeWithTools(
  model: BaseChatModel,
  messages: BaseMessage[]
): Promise<AIMessageChunk> {
  try {
    const result = await model.invoke(messages);
    return result as unknown as AIMessageChunk;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("AI", "invokeWithTools failed", {
      error: errMsg.substring(0, 200),
      messageCount: messages.length,
      model: resolveModel(),
    });
    throw error;
  }
}

// ─────────────────────────────────────────────
// Gemini REST API nativa — helpers internos
// ─────────────────────────────────────────────

/** Parsea la respuesta JSON de la API REST nativa de Gemini */
function parseGeminiResponse(
  data: Record<string, unknown>,
  logCtx: ReturnType<typeof logger.withContext>,
  caller: string
): { text: string; finishReason?: string; safetyBlocked: boolean } {
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined;

  // Gemini bloqueó el contenido por seguridad
  if (!candidates || candidates.length === 0) {
    const promptFeedback = data.promptFeedback as Record<string, unknown> | undefined;
    const blockReason = promptFeedback?.blockReason as string | undefined;
    const safetyRatings = promptFeedback?.safetyRatings as Array<Record<string, unknown>> | undefined;

    logCtx.warn("AI", `[${caller}] Gemini bloqueó la respuesta por seguridad`, {
      blockReason: blockReason || "unknown",
      safetyRatings: safetyRatings?.map(r => `${r.category}: ${r.probability}`).join(", ") || "none",
    });

    return { text: "", safetyBlocked: true };
  }

  const candidate = candidates[0];
  const finishReason = candidate.finishReason as string | undefined;
  const parts = (candidate.content as Record<string, unknown> | undefined)?.parts as Array<{ text: string }> | undefined;
  const text = parts?.[0]?.text || "";

  // Log finishReason si no es STOP
  if (finishReason && finishReason !== "STOP") {
    logCtx.warn("AI", `[${caller}] Gemini finishReason no estándar`, {
      finishReason,
      textLength: text.length,
      safetyRatings: (candidate.safetyRatings as Array<Record<string, unknown>>)
        ?.map(r => `${r.category}: ${r.probability}`).join(", ") || "none",
    });
  }

  if (!text && finishReason !== "SAFETY") {
    logCtx.warn("AI", `[${caller}] Gemini devolvió texto vacío`, {
      finishReason,
      candidateKeys: Object.keys(candidate),
    });
  }

  return {
    text,
    finishReason,
    safetyBlocked: finishReason === "SAFETY",
  };
}

/** Hace fetch a la API REST nativa de Gemini y parsea la respuesta */
async function fetchGeminiREST(
  url: string,
  body: Record<string, unknown>,
  logCtx: ReturnType<typeof logger.withContext>,
  caller: string
): Promise<{ text: string; finishReason?: string; safetyBlocked: boolean; rawResponse: unknown }> {
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unable to read error body");
      logCtx.error("AI", `[${caller}] Gemini API error HTTP`, undefined, {
        status: response.status,
        statusText: response.statusText,
        duration,
        errorBody: errorText.substring(0, 500),
      });
      throw new Error(`Gemini API HTTP ${response.status}: ${errorText.substring(0, 300)}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const parsed = parseGeminiResponse(data, logCtx, caller);

    logCtx.info("AI", `[${caller}] Gemini API call exitosa`, {
      duration,
      textLength: parsed.text.length,
      finishReason: parsed.finishReason,
    });

    return { ...parsed, rawResponse: data };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Gemini API HTTP")) {
      throw error; // ya tiene contexto
    }
    const duration = Date.now() - startTime;
    const errMsg = error instanceof Error ? error.message : String(error);
    logCtx.error("AI", `[${caller}] Gemini fetch error`, error instanceof Error ? error : undefined, {
      errorMessage: errMsg.substring(0, 300),
      duration,
      url: url.substring(0, 100),
    });
    throw new Error(`Gemini REST fetch failed (${caller}): ${errMsg}`);
  }
}

// ─────────────────────────────────────────────
// Gemini — Análisis nativo de archivos desde S3
// (PDF, imágenes, DOCX, TXT, etc.)
// ─────────────────────────────────────────────

/**
 * Detecta el mime type de un archivo según su extensión.
 */
function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Clasifica un archivo según su extensión para saber cómo procesarlo.
 */
function classifyFileType(fileName: string): 'pdf' | 'image' | 'docx' | 'text' | 'unknown' {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return 'pdf';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif'].includes(ext)) return 'image';
  if (ext === 'docx') return 'docx';
  if (['txt', 'csv', 'json', 'xml', 'log', 'md', 'html', 'htm'].includes(ext)) return 'text';
  return 'unknown';
}

// ─────────────────────────────────────────────
// System prompt compartido entre proveedores
// ─────────────────────────────────────────────

const MEDICAL_ANALYSIS_SYSTEM_PROMPT = `Eres un analista médico experto en interpretación de documentos clínicos y resultados de laboratorio, especializado en metabolismo keto y bajo en carbohidratos. Trabajas en el contexto de un coach de salud integral (NEL Health Coach).

## TONO PROFESIONAL CÁLIDO — IMPORTANTE:
Usa un tono profesional pero con calidez humana. Explica con claridad técnica pero con cercanía. NO suenes a reporte clínico frío.

- **Comienza siempre destacando lo positivo**: identifica los marcadores en rango óptimo antes de mencionar los que necesitan atención.
- **Para señalar áreas de mejora, sé constructivo**: preséntalo como un siguiente paso lógico, no como una advertencia.
- **Usa terminología del coach**: "ratio TG/HDL", "semáforo cardiovascular", "rangos óptimos", "perfil metabólico" — intégralo de forma natural.

## VISIÓN DEL COACH (NEL Health Coach):
Este análisis sigue la metodología de "El Poder de Tu Cuerpo" (Manuel Martínez).

### Métrica Rey: Ratio Triglicéridos / HDL
El **ratio TG/HDL es el "semáforo" cardiovascular**. Si tienes ambos valores, calcúlalo (TG ÷ HDL) e inclúyelo en el resumen:
  - **< 1**: Óptimo — perfil cardiovascular excelente, baja resistencia insulínica
  - **< 2**: Bueno — sólido, mantener rumbo
  - **≥ 2**: Atención — riesgo aterogénico, priorizar bajar triglicéridos

### Rangos Óptimos del Coach (vs rangos estándar):
  - Triglicéridos < 100 mg/dL | Insulina ayuno 3-5 μU/mL | Glucosa ayuno < 80 mg/dL
  - Vitamina D 50-60 ng/mL | HDL > 60 mg/dL | Cintura ≤ 50% altura

### Métricas Derivadas (cuando haya datos disponibles):
  - **Ratio Cintura/Altura**: ≤ 0.5 — indicador de grasa visceral más preciso que IMC
  - **HOMA-IR**: (glucosa × insulina) ÷ 405. Óptimo < 1.5 | > 2.5 = resistencia insulínica

PRINCIPIOS KETO:
- Interpreta los marcadores con óptica keto: LDL puede estar más alto fisiológicamente sin ser problemático si triglicéridos son bajos y HDL alto
- NO patologices valores esperables en keto (LDL elevado no es necesariamente malo si el ratio TG/HDL es favorable, idealmente < 2)
- NO diagnostiques enfermedades — solo extrae datos y provee contexto informativo
- Identifica valores fuera de rango y sugiere qué podrían significar bajo el contexto del paciente

EXTRACCIÓN:
1. Extrae TODOS los marcadores de laboratorio con sus valores exactos, unidades y rangos de referencia
2. Identifica fechas de exámenes y comparativas si existen
3. NO diagnostiques — solo extrae e interpreta datos
4. Para valores fuera de rango, indica su dirección (alto/bajo)

FORMATO DE RESPUESTA:
Debes responder ÚNICAMENTE con un objeto JSON válido, sin markdown, sin explicaciones, sin texto adicional.
El JSON debe tener esta estructura exacta:
{
  "medicalSummary": "Resumen conciso de los hallazgos principales del documento, interpretados bajo contexto keto",
  "medicalComparativeAnalysis": "Análisis comparativo si hay datos históricos, o 'No aplica' si es primera evaluación",
  "labResults": [
    {
      "name": "Nombre del biomarcador",
      "value": "Valor con unidades (ej: 95 mg/dL)",
      "range": "Rango de referencia (ej: 70-100 mg/dL)",
      "status": "normal" | "alto" | "bajo"
    }
  ],
  "supplementRecommendations": [
    {
      "name": "Nombre del suplemento",
      "dosage": "Dosis recomendada",
      "timing": "Momento del día",
      "rationale": "Justificación basada en biomarcadores alterados",
      "contraindications": "Contraindicaciones o 'Ninguna conocida'"
    }
  ]
}

REGLAS:
- NO incluyas \`\`\`json ni ningún marcador markdown
- NO añadas texto antes ni después del JSON
- Si no hay suplementos que recomendar, devuelve "supplementRecommendations": []
- Extrae TODOS los biomarcadores sin omitir ninguno
- Interpreta bajo óptica keto cuando aplique, pero siempre basado en los datos del documento`;

/**
 * Construye el mensaje de usuario con el texto extraído y contexto adicional.
 */
function buildAnalysisUserMessage(text: string, fileName: string, analysisContext?: string): string {
  return `${analysisContext ? `Contexto adicional: ${analysisContext}\n\n` : ''}A continuación está el contenido extraído del archivo "${fileName}":\n\n--- INICIO DEL DOCUMENTO ---\n${text}\n\n--- FIN DEL DOCUMENTO ---\n\nAnaliza este contenido médico y devuelve SOLAMENTE el objeto JSON con la estructura especificada.`;
}

/**
 * Valida que el texto a analizar tenga contenido mínimo.
 */
function validateAnalysisText(text: string, fileName: string, logCtx: ReturnType<typeof logger.withContext>): string | null {
  if (!text || text.trim().length < 10) {
    logCtx.warn('AI', 'El archivo no contiene texto extraíble', { fileName });
    return `[Documento sin texto extraíble: ${fileName}]\n\nEl sistema no pudo extraer texto de este archivo. Puede estar vacío, dañado, ser un PDF escaneado sin capa de texto, o tener un formato no soportado.`;
  }
  return null;
}

// ─────────────────────────────────────────────
// DeepSeek REST API (OpenAI-compatible)
// ─────────────────────────────────────────────

/**
 * Envía texto a DeepSeek vía API REST OpenAI-compatible.
 */
async function sendTextToDeepSeekREST(
  text: string,
  fileName: string,
  analysisContext?: string,
): Promise<string> {
  const caller = 'sendTextToDeepSeek';
  const logCtx = logger.withContext({ tool: 'deepseek-text-analysis', fileName });

  const invalid = validateAnalysisText(text, fileName, logCtx);
  if (invalid) return invalid;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required');

  const model = process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL;
  const baseUrl = process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL;
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: "system", content: MEDICAL_ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: buildAnalysisUserMessage(text, fileName, analysisContext) },
    ],
    response_format: { type: "json_object" } as const,
    temperature: 0.2,
    max_tokens: 16000,
  };

  const startTime = Date.now();
  logCtx.info('AI', `[${caller}] Enviando a DeepSeek`, {
    model,
    chars: text.length,
    contextProvided: !!analysisContext,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const duration = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logCtx.error('AI', `[${caller}] DeepSeek API error`, undefined, {
      status: response.status,
      statusText: response.statusText,
      duration,
      errorBody: errorText.substring(0, 500),
    });
    throw new Error(`DeepSeek API HTTP ${response.status}: ${errorText.substring(0, 300)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const content = choices?.[0]?.message as Record<string, unknown> | undefined;
  const resultText = (content?.content as string) ?? '';
  const finishReason = choices?.[0]?.finish_reason ?? choices?.[0]?.finishReason ?? null;

  logCtx.info('AI', `[${caller}] DeepSeek respondió exitosamente`, {
    duration,
    textLength: resultText.length,
    finishReason,
    reasoningTokens: (content as any)?.reasoning_content
      ? ((content as any).reasoning_content as string).length
      : 0,
  });

  // SEC-ROBUSTEZ: respuesta vacía o solo-razonamiento (deepseek reasoner gastó
  // todo el presupuesto en reasoning_content) → LANZAR para que el fallback
  // (Gemini) se ejecute. Antes se devolvía "[Documento sin análisis: X]" que
  // NO es JSON y corrompía el análisis aguas abajo (SyntaxError 'D').
  if (!resultText || resultText.trim().length === 0) {
    throw new Error(
      `DeepSeek devolvió respuesta VACÍA para ${fileName} (finishReason=${finishReason ?? 'unknown'}). ` +
      `Presupuesto agotado en razonamiento (reasoning_content). Reintentando con Gemini.`
    );
  }

  return resultText;
}

// ─────────────────────────────────────────────
// Gemini REST API nativa — análisis de texto
// ─────────────────────────────────────────────

/**
 * Envía texto plano a Gemini vía REST API nativa para análisis médico.
 * Es la implementación interna — la pública sendTextToGemini usa fallback.
 */
async function sendTextToGeminiREST(
  text: string,
  fileName: string,
  analysisContext?: string,
): Promise<string> {
  const caller = 'sendTextToGeminiREST';
  const logCtx = logger.withContext({ tool: 'gemini-text-analysis', fileName });

  const invalid = validateAnalysisText(text, fileName, logCtx);
  if (invalid) return invalid;

  const model = resolveModel();
  const url = `${GEMINI_REST_URL}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: MEDICAL_ANALYSIS_SYSTEM_PROMPT }],
    },
    contents: [{
      parts: [{ text: buildAnalysisUserMessage(text, fileName, analysisContext) }],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
    },
  };

  const result = await fetchGeminiREST(url, body, logCtx, caller);

  if (result.safetyBlocked) {
    return `[Documento bloqueado por seguridad: ${fileName}]`;
  }

  return result.text || `[Documento sin texto extraíble: ${fileName}]`;
}

/**
 * Envía texto plano para análisis médico con fallback automático.
 *
 * Estrategia:
 *   1. Intenta DeepSeek primero (más rápido, más disponible)
 *   2. Si DeepSeek falla → intenta Gemini
 *   3. Si ambos fallan → lanza error
 */
export async function sendTextToGemini(
  text: string,
  fileName: string,
  analysisContext?: string,
): Promise<string> {
  const caller = 'sendTextToGemini';
  const logCtx = logger.withContext({ tool: 'text-analysis-fallback', fileName });

  const invalid = validateAnalysisText(text, fileName, logCtx);
  if (invalid) return invalid;

  // 1. DeepSeek (primario)
  try {
    logCtx.info('AI', `[${caller}] Intentando con DeepSeek (primario)`);
    return await sendTextToDeepSeekREST(text, fileName, analysisContext);
  } catch (deepseekError: unknown) {
    const dsMsg = deepseekError instanceof Error ? deepseekError.message : String(deepseekError);
    logCtx.warn('AI', `[${caller}] DeepSeek falló, probando Gemini (fallback)`, {
      error: dsMsg.substring(0, 200),
    });
  }

  // 2. Gemini (fallback)
  try {
    return await sendTextToGeminiREST(text, fileName, analysisContext);
  } catch (geminiError: unknown) {
    const gmMsg = geminiError instanceof Error ? geminiError.message : String(geminiError);
    logCtx.error('AI', `[${caller}] Ambos proveedores fallaron (DeepSeek → Gemini)`, undefined, {
      geminiError: gmMsg.substring(0, 200),
    });
    throw new Error(`Ambos proveedores LLM fallaron. DeepSeek → Gemini. Último error: ${gmMsg}`);
  }
}

/**
 * Analiza un archivo con Gemini: extrae texto LOCALMENTE y envía solo texto plano.
 *
 * Es un wrapper que combina extracción + envío a Gemini.
 * Para flujos donde ya tenés el texto extraído (ej: analyzeS3FileWithGemini),
 * se usa sendTextToGemini directamente para evitar extracción duplicada.
 */
export async function analyzeFileWithGemini(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  fileType: 'pdf' | 'image' | 'docx' | 'text',
  analysisContext?: string,
): Promise<string> {
  const caller = 'analyzeFile';
  const logCtx = logger.withContext({ tool: 'gemini-file-analysis', fileName });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');

    logCtx.info('AI', `[${caller}] Iniciando análisis de archivo`, {
      fileType,
      mimeType,
      sizeKB: Math.round(fileBuffer.byteLength / 1024),
      contextProvided: !!analysisContext,
    });

    // 1. Extraer texto LOCALMENTE
    const extracted: ExtractionResult = await extractTextFromBuffer(
      fileBuffer,
      fileName,
      mimeType,
    );

    logCtx.info('AI', `[${caller}] Texto extraído localmente`, {
      method: extracted.method,
      chars: extracted.text.length,
      pages: extracted.pages,
      ocrConfidence: extracted.ocrConfidence,
    });

    // 2. Enviar a Gemini (sin re-extraer)
    return sendTextToGemini(extracted.text, fileName, analysisContext);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logCtx.error(
      'AI',
      `[${caller}] Falló el análisis de archivo`,
      error instanceof Error ? error : undefined,
      {
        fileName,
        fileType,
        errorMessage: errorMessage.substring(0, 300),
      },
    );
    throw error;
  }
}

/**
 * Versátil: descarga cualquier archivo de S3 y lo analiza con Gemini.
 * Soporta: PDF, imágenes (JPG, PNG, GIF, WebP), DOCX, TXT, CSV, JSON.
 */
/** Resultado de analizar un archivo desde S3: análisis de Gemini + metadatos de extracción */
export interface S3FileAnalysisResult {
  /** Respuesta textual de Gemini con el análisis médico */
  analysis: string;
  /** Texto plano extraído localmente del archivo */
  rawText: string;
  /** Método usado para la extracción local */
  extractionMethod: string;
}

// ─────────────────────────────────────────────
// Gemini — Análisis multimodal nativo de imágenes
// ─────────────────────────────────────────────

/**
 * Envía una imagen directamente a Gemini vía REST API multimodal.
 * Gemini extrae texto, interpreta gráficos/tablas y devuelve JSON médico.
 * Reemplaza el flujo de OCR local (tesseract.js) que no es confiable en serverless.
 */
async function sendImageToGeminiREST(
  imageBuffer: Buffer,
  fileName: string,
  mimeType: string,
  analysisContext?: string,
): Promise<string> {
  const caller = 'sendImageToGeminiREST';
  const logCtx = logger.withContext({ tool: 'gemini-multimodal-image', fileName });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const model = resolveModel();
  const url = `${GEMINI_REST_URL}/models/${model}:generateContent?key=${apiKey}`;

  const base64Image = imageBuffer.toString('base64');

  // Prompt específico para análisis de imágenes de documentos médicos
  const userPrompt = `${analysisContext ? `Contexto adicional: ${analysisContext}\n\n` : ''}Esta es una imagen del archivo "${fileName}". Analízala como un documento médico: extrae todo el texto visible, interpreta tablas, gráficos o resultados de laboratorio, y devuelve SOLAMENTE el objeto JSON con la estructura especificada.`;

  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: MEDICAL_ANALYSIS_SYSTEM_PROMPT }],
    },
    contents: [{
      parts: [
        { text: userPrompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Image,
          },
        },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
    },
  };

  const result = await fetchGeminiREST(url, body, logCtx, caller);

  if (result.safetyBlocked) {
    return `[Documento bloqueado por seguridad: ${fileName}]`;
  }

  return result.text || `[Documento sin contenido visible: ${fileName}]`;
}

// ─────────────────────────────────────────────
// Gemini — Extracción de texto desde imágenes
// (para cache post-upload, sin análisis médico)
// ─────────────────────────────────────────────

/**
 * Extrae texto de una imagen usando Gemini multimodal.
 * A diferencia de sendImageToGeminiREST, NO hace análisis médico —
 * solo pide a Gemini que transcriba el texto visible.
 * Útil como fallback en extractAndCacheDocument cuando tesseract.js falla.
 */
export async function extractTextFromImageViaGemini(
  imageBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const caller = 'extractTextFromImageViaGemini';
  const logCtx = logger.withContext({ tool: 'gemini-image-text-extraction', fileName });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const model = resolveModel();
  const url = `${GEMINI_REST_URL}/models/${model}:generateContent?key=${apiKey}`;

  const base64Image = imageBuffer.toString('base64');

  const body: Record<string, unknown> = {
    contents: [{
      parts: [
        {
          text: `Extrae TODO el texto visible en esta imagen del archivo "${fileName}". Preserva la estructura original: respeta saltos de línea, tablas, listas y cualquier formato. No agregues comentarios, no resumas, no interpretes — SOLO transcribe el texto exacto que ves. Si la imagen no contiene texto legible, devuelve una cadena vacía.`,
        },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Image,
          },
        },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  };

  const result = await fetchGeminiREST(url, body, logCtx, caller);

  if (result.safetyBlocked) {
    logCtx.warn('AI', `[${caller}] Gemini bloqueó la imagen por seguridad`, { fileName });
    return '';
  }

  return result.text || '';
}

export async function analyzeS3FileWithGemini(
  s3Key: string,
  fileName: string,
  analysisContext?: string,
): Promise<S3FileAnalysisResult> {
  const caller = 'analyzeS3File';
  const logCtx = logger.withContext({ tool: 'gemini-s3-file-analysis', s3Key, fileName });

  try {
    const fileType = classifyFileType(fileName);
    const mimeType = getMimeType(fileName);

    logCtx.info('AI', `[${caller}] Descargando archivo de S3`, {
      fileType,
      mimeType,
    });

    const { getPresignedUrlForAnalysis } = await import('../../s3');
    const presignedUrl = await getPresignedUrlForAnalysis(s3Key);

    const s3StartTime = Date.now();
    const response = await fetch(presignedUrl);

    if (!response.ok) {
      logCtx.error('AI', `[${caller}] Error descargando archivo de S3`, undefined, {
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(`S3 download failed: ${response.status} ${response.statusText}`);
    }

    const fileBuffer = await response.arrayBuffer();
    const s3Duration = Date.now() - s3StartTime;

    logCtx.info('AI', `[${caller}] Archivo descargado de S3`, {
      sizeKB: Math.round(fileBuffer.byteLength / 1024),
      s3Duration,
      fileType,
    });

    const buffer = Buffer.from(fileBuffer);

    // ── Ruta para imágenes: Gemini multimodal nativo ──
    // Gemini entiende imágenes directamente, evitando OCR local
    // (tesseract.js) que tiene problemas con worker_threads en serverless.
    if (fileType === 'image') {
      logCtx.info('AI', `[${caller}] Imagen detectada — usando Gemini multimodal nativo`);

      const analysis = await sendImageToGeminiREST(buffer, fileName, mimeType, analysisContext);

      return {
        analysis,
        rawText: '',
        extractionMethod: 'gemini-multimodal',
      };
    }

    // ── Ruta para documentos (PDF, DOCX, texto): extracción local + texto ──
    const extracted: ExtractionResult = await extractTextFromBuffer(buffer, fileName, mimeType);
    logCtx.info('AI', `[${caller}] Texto extraído localmente`, {
      method: extracted.method,
      chars: extracted.text.length,
      pages: extracted.pages,
      ocrConfidence: extracted.ocrConfidence,
    });

    // Enviar texto extraído directamente a Gemini (sin re-extraer)
    const analysis = await sendTextToGemini(extracted.text, fileName, analysisContext);

    return {
      analysis,
      rawText: extracted.text,
      extractionMethod: extracted.method,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logCtx.error('AI', `[${caller}] Falló`, error instanceof Error ? error : undefined, {
      s3Key,
      fileName,
      errorMessage: errorMessage.substring(0, 300),
    });
    throw error;
  }
}

// Mantener compatibilidad hacia atrás
export async function analyzePDFWithGemini(
  pdfBase64: string,
  fileName: string,
  analysisContext?: string,
): Promise<S3FileAnalysisResult> {
  const buffer = Buffer.from(pdfBase64, 'base64');
  const extracted = await extractTextFromBuffer(buffer, fileName, 'application/pdf');
  const analysis = await sendTextToGemini(extracted.text, fileName, analysisContext);
  return {
    analysis,
    rawText: extracted.text,
    extractionMethod: extracted.method,
  };
}

export async function analyzeS3PDFWithGemini(
  s3Key: string,
  fileName: string,
  analysisContext?: string,
): Promise<S3FileAnalysisResult> {
  return analyzeS3FileWithGemini(s3Key, fileName, analysisContext);
}

// ─────────────────────────────────────────────
// Gemini REST API — Llamadas directas centralizadas
// ─────────────────────────────────────────────

interface GeminiGenerateContentParams {
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
}

interface GeminiGenerateContentResponse {
  text: string;
  rawResponse: unknown;
}

export async function callGeminiAPI(
  params: GeminiGenerateContentParams
): Promise<GeminiGenerateContentResponse> {
  const caller = "callGeminiAPI";
  const logCtx = logger.withContext({ caller });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logCtx.error("AI", "GEMINI_API_KEY no configurada");
    throw new Error("GEMINI_API_KEY is required");
  }

  const model = resolveModel();
  const url = `${GEMINI_REST_URL}/models/${model}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: params.userPrompt }] }],
    generationConfig: {
      temperature: params.temperature ?? 0.7,
      maxOutputTokens: params.maxOutputTokens ?? 8000,
    },
  };

  if (params.systemPrompt) {
    body.systemInstruction = { parts: [{ text: params.systemPrompt }] };
  }

  if (params.responseMimeType) {
    (body.generationConfig as Record<string, unknown>).responseMimeType =
      params.responseMimeType;
  }

  logCtx.debug("AI", `[${caller}] Llamando a Gemini`, {
    model,
    temperature: params.temperature ?? 0.7,
    maxOutputTokens: params.maxOutputTokens ?? 8000,
    promptLength: params.userPrompt.length,
    hasSystemPrompt: !!params.systemPrompt,
    responseMimeType: params.responseMimeType || "none",
  });

  const result = await fetchGeminiREST(url, body, logCtx, caller);

  if (result.safetyBlocked) {
    throw new Error(
      "Gemini blocked the response due to safety filters. Prompt may contain sensitive content."
    );
  }

  if (!result.text) {
    throw new Error(
      `Gemini returned empty text. finishReason: ${result.finishReason || "unknown"}. ` +
      "Possible causes: content filtered, max_tokens too low, or model error."
    );
  }

  return { text: result.text, rawResponse: result.rawResponse };
}

export async function callGeminiAPIWithRetry(
  params: GeminiGenerateContentParams,
  maxRetries: number = 3
): Promise<GeminiGenerateContentResponse> {
  const caller = "callGeminiAPIWithRetry";
  const logCtx = logger.withContext({ caller });

  const errors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logCtx.info("AI", `[${caller}] Reintento ${attempt}/${maxRetries}`);
      }
      return await callGeminiAPI(params);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`attempt ${attempt + 1}: ${errMsg.substring(0, 150)}`);

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 3000; // 3s, 6s, 12s — increased base for 503 resilience
        logCtx.warn("AI", `[${caller}] Falló intento ${attempt + 1}/${maxRetries + 1}, reintentando en ${delay}ms`, {
          error: errMsg.substring(0, 150),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const fullError = `Gemini API failed after ${maxRetries + 1} attempts:\n${errors.join("\n")}`;
  logCtx.error("AI", `[${caller}] Todos los reintentos fallaron`, undefined, {
    totalAttempts: maxRetries + 1,
    errors: errors.join(" | "),
  });
  throw new Error(fullError);
}

export async function testGeminiConnection(): Promise<boolean> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      logger.warn("AI", "[testGeminiConnection] GEMINI_API_KEY no configurada");
      return false;
    }

    const model = resolveModel();
    const url = `${GEMINI_REST_URL}/models/${model}:generateContent?key=${apiKey}`;

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });

    const duration = Date.now() - startTime;

    if (response.ok) {
      logger.info("AI", "[testGeminiConnection] Conexión exitosa", { model, duration });
      return true;
    }

    const errorText = await response.text().catch(() => "Unable to read error");
    logger.warn("AI", "[testGeminiConnection] Falló la conexión", {
      status: response.status,
      statusText: response.statusText,
      duration,
      errorBody: errorText.substring(0, 300),
    });
    return false;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("AI", "[testGeminiConnection] Error de red", {
      error: errMsg.substring(0, 200),
    });
    return false;
  }
}
