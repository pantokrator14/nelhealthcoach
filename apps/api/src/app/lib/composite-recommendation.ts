/**
 * Generación de recomendaciones con PIPELINE SECUENCIAL (3 fases).
 *
 * Fase 1: Analista Clínico — Extrae biomarcadores de documentos médicos (structuredMedicalAnalysis).
 * Fase 2: Health Coach — Genera plan de nutrición (7 días), ejercicios y hábitos usando Fase 1 como contexto.
 * Fase 3: Asistente Logístico — Extrae y consolida la lista de compras del weeklyPlan generado en Fase 2.
 *
 * Cada fase es una llamada LLM independiente para evitar "atención degradada" en prompts masivos.
 */

import { createDeepSeekJSONLLM, robustJsonParse } from "./agents/utils/llm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { logger } from "./logger";

// ── Interfaces de Entrada ──────────────────────────────────

export interface CompositeInput {
  personalData: Record<string, unknown>;
  medicalData: Record<string, unknown>;
  healthAssessment: Record<string, string>;
  mentalHealth: Record<string, string>;
  processedDocuments: Array<{ title: string; content: string; documentType: string; confidence: number }>;
  previousSessions: Array<Record<string, unknown>>;
  coachNotes: string;
  monthNumber: number;
}

// ── Interfaces de Salida por Fase ──────────────────────────

/** Fase 1: Solo análisis médico (estructura inmutable) */
export interface MedicalOutput {
  medicalSummary: string;
  medicalComparativeAnalysis: string;
  labResults: Array<{
    name: string;
    value: string;
    range: string;
    status: 'normal' | 'alto' | 'bajo';
  }>;
  structuredMedicalAnalysis: {
    exams: Array<{
      intro: string;
      table: Array<{ biomarcador: string; valor: string; rango_normal: string; estado: 'Alto' | 'Bajo' | 'Normal' }>;
      analysis: string;
    }>;
    supplements: Array<{
      name: string;
      dosage: string;
      timing: string;
      rationale: string;
      contraindications?: string;
    }>;
  };
}

/** Fase 2: Plan de estilo de vida + clientInsights (sin datos médicos crudos) */
export interface LifestyleOutput {
  clientInsights: {
    summary: string;
    vision: string;
    keyRisks: string[];
    opportunities: string[];
    experienceLevel: "principiante" | "intermedio" | "avanzado";
    idealWeight: string;
    idealBodyFat: string;
    targetImprovements: string[];
  };
  nutritionPlan: {
    weeklyPlan: Array<{
      day: string;
      breakfast: string;
      lunch: string;
      dinner: string;
    }>;
    shoppingList: Array<{ item: string; quantity: string; priority: "high" | "medium" | "low" }>;
  };
  exercisePlan: {
    weeklyRoutine: Array<{
      day: string;
      exercises: Array<{
        name: string;
        sets: number;
        repetitions: string;
        timeUnderTension: string;
        progression: string;
      }>;
    }>;
    equipment: string[];
    notes: string;
  };
  habitPlan: {
    toAdopt: Array<{ habit: string; frequency: string; trigger: string }>;
    toEliminate: Array<{ habit: string; replacement: string }>;
    trackingMethod: string;
    motivationTip: string;
  };
  alternatives?: Array<{
    meal: string;
    recipe: string;
    description: string;
  }>;
}

/** Fase 3: Solo lista de compras (extraída del weeklyPlan de Fase 2) */
export interface ShoppingListOutput {
  shoppingList: Array<{ item: string; quantity: string; priority: "high" | "medium" | "low" }>;
}

// ── Interface de Salida Final (fusión de ambas fases) ──────

export interface CompositeOutput {
  clientInsights: {
    summary: string;
    vision: string;
    keyRisks: string[];
    opportunities: string[];
    experienceLevel: "principiante" | "intermedio" | "avanzado";
    idealWeight: string;
    idealBodyFat: string;
    targetImprovements: string[];
    medicalSummary: string;
    medicalComparativeAnalysis: string;
    labResults?: Array<{
      name: string;
      value: string;
      range: string;
      status: 'normal' | 'alto' | 'bajo';
    }>;
    structuredMedicalAnalysis?: {
      exams: Array<{
        intro: string;
        table: Array<{ biomarcador: string; valor: string; rango_normal: string; estado: 'Alto' | 'Bajo' | 'Normal' }>;
        analysis: string;
      }>;
      supplements: Array<{
        name: string;
        dosage: string;
        timing: string;
        rationale: string;
        contraindications?: string;
      }>;
    };
  };
  nutritionPlan: {
    weeklyPlan: Array<{
      day: string;
      breakfast: string;
      lunch: string;
      dinner: string;
    }>;
    shoppingList: Array<{ item: string; quantity: string; priority: "high" | "medium" | "low" }>;
  };
  exercisePlan: {
    weeklyRoutine: Array<{
      day: string;
      exercises: Array<{
        name: string;
        sets: number;
        repetitions: string;
        timeUnderTension: string;
        progression: string;
      }>;
    }>;
    equipment: string[];
    notes: string;
  };
  habitPlan: {
    toAdopt: Array<{ habit: string; frequency: string; trigger: string }>;
    toEliminate: Array<{ habit: string; replacement: string }>;
    trackingMethod: string;
    motivationTip: string;
  };
  alternatives?: Array<{
    meal: string;
    recipe: string;
    description: string;
  }>;
}

// ── Formateo de datos ──────────────────────────────────────

function formatPersonalData(data: Record<string, unknown>, sessionCount = 0): string {
  return [
    `- Nombre: ${data.name || "No especificado"}`,
    `- Edad: ${data.age || "N/A"}`,
    `- Peso: ${data.weight || "N/A"} | Altura: ${data.height || "N/A"}`,
    `- Género: ${data.gender || "No esp."} | Ocupación: ${data.occupation || "No esp."}`,
    `- Estado civil: ${data.maritalStatus || "No esp."} | Educación: ${data.education || "No esp."}`,
    `- Sesiones previas: ${sessionCount} | Nivel aproximado: ${sessionCount === 0 ? "principiante" : sessionCount < 3 ? "intermedio" : "avanzado"}`,
  ].join("\n");
}

function formatMedicalSummary(data: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    mainComplaint: "Motivo", currentPastConditions: "Condiciones", allergies: "Alergias",
    medications: "Medicamentos", supplements: "Suplementos", surgeries: "Cirugías",
    employmentHistory: "Trabajo", hobbies: "Hobbies", physicalLimitations: "Limitaciones físicas",
    gymAccess: "Acceso a gym", gymAccessDetails: "Detalles de acceso a gym",
    preferredExerciseTypes: "Ejercicios preferidos", exerciseTimeAvailability: "Disponibilidad para ejercicio",
    currentActivityLevel: "Nivel de actividad actual", whoCooks: "Quién cocina y con quién vive",
    housingHistory: "Historial de vivienda (exposición ambiental)",
    dislikedFoodsActivities: "Comidas/actividades que NO le gustan",
    typicalWeekday: "Día de semana típico", typicalWeekend: "Fin de semana típico",
  };
  return Object.entries(labels).map(([k, v]) => data[k] ? `- ${v}: ${data[k]}` : "").filter(Boolean).join("\n") || "- Sin datos médicos";
}

function formatHealthAssess(data: Record<string, string>): string {
  if (!data || Object.keys(data).length === 0) return "- Sin evaluaciones";
  return Object.entries(data)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n") || "- Sin evaluaciones";
}

function formatMental(data: Record<string, string>): string {
  if (!data || Object.keys(data).length === 0) return "- Sin datos";
  return Object.entries(data)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n") || "- Sin datos";
}

function formatDocs(docs: Array<{ title: string; content: string }>): string {
  if (!docs?.length) return "- Sin docs";
  return docs.map((d, i) => `${i + 1}. ${d.title}\n${d.content.substring(0, 3000)}`).join("\n\n");
}

// ── Prompts por Fase ───────────────────────────────────────

/** Prompt Fase 1: Analista Clínico (SOLO documentos médicos) */
function buildMedicalPrompt(
  input: CompositeInput
): { system: string; human: string } {
  const hasDocuments = input.processedDocuments && input.processedDocuments.length > 0;

  return {
    system: "ERES UN ANALISTA CLÍNICO. TU RESPUESTA DEBE SER UN JSON VÁLIDO. Esta es tu ÚNICA tarea: extraer biomarcadores de documentos médicos y generar suplementación. NO generes planes de nutrición ni ejercicios.",
    human: `Eres un analista médico experto. Tu ÚNICA tarea es analizar los documentos clínicos del cliente y generar una estructura JSON con los campos: medicalSummary, medicalComparativeAnalysis, labResults, y structuredMedicalAnalysis.

## DATOS MÉDICOS DEL CLIENTE
${formatMedicalSummary(input.medicalData)}

## DOCUMENTOS CLÍNICOS
${hasDocuments ? formatDocs(input.processedDocuments) : "- NO HAY DOCUMENTOS MÉDICOS DISPONIBLES"}

${input.coachNotes ? `### NOTAS DEL COACH\n${input.coachNotes}\n` : ""}

## INSTRUCCIONES DE SALIDA JSON

${hasDocuments ? `
### OBLIGATORIO: Genera structuredMedicalAnalysis procesando TODOS los datos de laboratorio extraídos de los documentos.
- Agrupa los valores en "exams" (cada examen con "intro", "table" de biomarcadores, y "analysis")
- Propone suplementación específica en "supplements" basada en biomarcadores alterados
- REGLAS ANTI-ALUCINACIÓN: Extrae estrictamente los valores clínicos. IGNORA texto administrativo o menciones de "visitas programadas". NO supongas condiciones genéticas sin contexto explícito. Ofrece alternativas, no diagnósticos concluyentes.
- ⚠️ SI hay documentos y structuredMedicalAnalysis.exams está vacío, tu respuesta se considera INVÁLIDA.
` : `
### NO hay documentos médicos: Devuelve medicalSummary="", medicalComparativeAnalysis="", labResults=[], structuredMedicalAnalysis con exams:[] y supplements:[]
`}

\`\`\`json
{
  "medicalSummary": "${hasDocuments ? "Análisis detallado de laboratorios y biomarcadores extraídos de los documentos" : ""}",
  "medicalComparativeAnalysis": "${hasDocuments ? "Comparativa entre documentos identificando tendencias" : ""}",
  "labResults": [
    ${hasDocuments ? '{ "name": "Glucosa", "value": "95 mg/dL", "range": "70-100 mg/dL", "status": "normal" }' : ""}
  ],
  "structuredMedicalAnalysis": {
    "exams": [
      ${hasDocuments ? `{
        "intro": "El panel de lípidos del paciente muestra...",
        "table": [
          { "biomarcador": "Colesterol Total", "valor": "245 mg/dL", "rango_normal": "125-200 mg/dL", "estado": "Alto" }
        ],
        "analysis": "El colesterol total se encuentra significativamente elevado..."
      }` : ""}
    ],
    "supplements": [
      ${hasDocuments ? '{ "name": "Omega-3", "dosage": "2000 mg/día", "timing": "Con el almuerzo", "rationale": "LDL y triglicéridos elevados", "contraindications": "Precaución con anticoagulantes" }' : ""}
    ]
  }
}
\`\`\`

Responde SOLO con el JSON, sin texto adicional.`
  };
}

/** Prompt Fase 2: Health Coach (estilo de vida + contexto médico de Fase 1) */
function buildLifestylePrompt(
  input: CompositeInput,
  dbRecipes: Array<{ _id: string; title: string; cookTime: number; difficulty: string; category: string[] }>,
  dbExercises: Array<{ _id: string; name: string; difficulty: string; clientLevel: string; equipment: string[]; muscleGroups: string[] }>,
  medicalResult: MedicalOutput
): { system: string; human: string } {
  const recipeList = dbRecipes.map(r =>
    `- [ID:${r._id}] "${r.title}" (⏱${r.cookTime}min | ${r.difficulty})`
  ).join("\n");

  const exerciseList = dbExercises.map(e =>
    `- [ID:${e._id}] "${e.name}" (${e.difficulty} | ${e.clientLevel} | ${e.equipment.join(',') || 'sin equipo'})`
  ).join("\n");

  const medicalContext = medicalResult.structuredMedicalAnalysis.exams.length > 0
    ? `## ANÁLISIS MÉDICO PREVIO (CONTEXTO INMUTABLE — ÚSALO PARA PERSONALIZAR EL PLAN)
- Resumen médico: ${medicalResult.medicalSummary}
- Biomarcadores alterados detectados: ${medicalResult.labResults.filter(lr => lr.status !== 'normal').map(lr => `${lr.name}: ${lr.value} (${lr.status})`).join(', ') || 'Ninguno'}
- Suplementos recomendados: ${medicalResult.structuredMedicalAnalysis.supplements.map(s => `${s.name} (${s.dosage})`).join(', ') || 'Ninguno'}
- Considera estos hallazgos al diseñar el plan de nutrición y ejercicios. Evita alimentos que contradigan los biomarcadores alterados.`
    : '## NO SE DETECTARON DOCUMENTOS MÉDICOS — Diseña el plan basándote únicamente en los datos de estilo de vida del cliente.';

  return {
    system: "Eres un health coach experto. Basándote en el análisis médico previo proporcionado como contexto, genera un plan de nutrición de 7 días, ejercicios y hábitos personalizado. Responde EXACTAMENTE con el JSON solicitado.",
    human: `Eres un entrenador de salud integral. Diseña un plan de 7 días (Lunes a Domingo) que se repetirá durante 4 semanas (1 mes) para este cliente.

${medicalContext}

## DATOS DEL CLIENTE
${formatPersonalData(input.personalData, input.previousSessions.length)}

### Salud y estilo de vida
${formatMedicalSummary(input.medicalData)}

### Evaluaciones de salud
${formatHealthAssess(input.healthAssessment)}

### Salud mental
${formatMental(input.mentalHealth)}

${input.coachNotes ? `### NOTAS DEL COACH\n${input.coachNotes}\n` : ""}

## RECETAS DISPONIBLES EN LA BASE DE DATOS (DEBES USAR SOLO ESTAS)
${recipeList || "- No hay recetas en la DB"}

## EJERCICIOS DISPONIBLES EN LA BASE DE DATOS (DEBES USAR SOLO ESTOS)
${exerciseList || "- No hay ejercicios en la DB"}

## GENERA ESTE JSON USANDO LOS IDs DE LAS LISTAS DE ARRIBA

### 1. clientInsights — Análisis del cliente (BREVE: summary y vision deben ser cortos, sin tanto detalle)
- TONO PROFESIONAL CON CALIDEZ: Usa un tono profesional pero cálido — como un coach que es claro y directo pero también alentador. summary debe comenzar destacando aspectos positivos, fortalezas y logros del cliente, y luego mencionar los desafíos de forma constructiva sin sonar demasiado informal ni demasiado clínico.
- summary: Resumen breve y equilibrado que reconozca fortalezas y logros, y señale áreas de mejora con un tono constructivo (2-3 líneas máximo)
- vision: Visión corta de cómo estará el cliente en 4 semanas (1 mes) — con un tono realista pero motivador (2-3 líneas máximo)

### 2. nutritionPlan — PLAN DE COMIDAS (7 días)
- weeklyPlan: array de 7 objetos (Monday a Sunday)
- Cada día: breakfast, lunch, dinner con el TÍTULO EXACTO de la receta
- DEBES usar SOLO recetas de la lista de arriba. Copia el título EXACTO
- shoppingList: lista de compras con cantidades totales
- IMPORTANTE: Devuelve los ingredientes en una ÚNICA lista unificada. ESTÁ PROHIBIDO categorizar o agrupar por semanas o días.

### 3. exercisePlan — RUTINA DE EJERCICIOS
- weeklyRoutine: días específicos (NO todos, típicamente 3-4 días/semana) con exercises[]
- Cada ejercicio: name con el NOMBRE EXACTO de la lista de arriba
- SELECCIÓN POR NIVEL: clientLevel debe coincidir con el nivel del cliente
- ⚠️ REGLA DE ORO DE CONCURRENCIA SEMANAL: El plan de ejercicios debe tener una frecuencia ESTRICTA de máximo 3 o 4 días por semana (por ejemplo: Lunes, Miércoles y Viernes). Está rotundamente PROHIBIDO asignar rutinas intensas para los 7 días de la semana.
- ⚠️ GUARDIA ANTE CONTEXTO VACÍO: Si los campos de 'gymAccess', 'gymAccessDetails' o 'preferredExerciseTypes' vienen vacíos o no especificados en el perfil del cliente, DEBES asumir por defecto que el cliente NO tiene equipo y entrenará en casa. Diseña la rutina usando exclusivamente ejercicios de peso corporal (Bodyweight) y calistenia ligera enfocada en movilidad y fuerza funcional básica.

### 4. habitPlan — HÁBITOS 
- toAdopt: array con "habit", "frequency", "trigger"
- toEliminate: array con "habit", "replacement"
- trackingMethod, motivationTip

### 5. alternatives — alternativas de recetas (OBLIGATORIO: al menos 3)
- alternatives: array con "meal", "recipe" (TÍTULO EXACTO), "description"

\`\`\`json
{
  "clientInsights": {
    "summary": "Resumen breve del estado actual del cliente...",
    "vision": "Visión corta de cómo estará el cliente en 4 semanas (1 mes)...",
    "keyRisks": ["..."],
    "opportunities": ["..."],
    "experienceLevel": "principiante|intermedio|avanzado",
    "idealWeight": "XX kg",
    "idealBodyFat": "XX%",
    "targetImprovements": ["..."]
  },
  "nutritionPlan": {
    "weeklyPlan": [
      { "day": "Monday", "breakfast": "TÍTULO EXACTO DE RECETA", "lunch": "...", "dinner": "..." },
      { "day": "Tuesday", ... },
      { "day": "Wednesday", ... },
      { "day": "Thursday", ... },
      { "day": "Friday", ... },
      { "day": "Saturday", ... },
      { "day": "Sunday", ... }
    ],
    "shoppingList": [...]
  },
  "exercisePlan": {
    "weeklyRoutine": [
      { "day": "Monday", "exercises": [{ "name": "NOMBRE EXACTO DE EJERCICIO", "sets": 3, "repetitions": "12", "timeUnderTension": "3-1-1", "progression": "..." }] }
    ],
    "equipment": [...],
    "notes": "..."
  },
  "habitPlan": { "toAdopt": [...], "toEliminate": [...], "trackingMethod": "...", "motivationTip": "..." },
  "alternatives": [...]
}
\`\`\`

IMPORTANTE:
- USA SOLO recetas y ejercicios de las listas proporcionadas
- Copia los títulos/nombres EXACTAMENTE como aparecen
- vision DEBE ser tan extensa y detallada como summary
- Responde SOLO con el JSON, sin texto adicional`
  };
}

/** Prompt Fase 3: Asistente Logístico (SOLO lista de compras a partir del weeklyPlan) */
function buildShoppingListPrompt(
  weeklyPlan: Array<{ day: string; breakfast: string; lunch: string; dinner: string }>,
  recipeIngredients?: Record<string, string[]>
): { system: string; human: string } {
  let humanContent = `Aquí está el plan de comidas semanal:\n\n${JSON.stringify(weeklyPlan, null, 2)}`;

  if (recipeIngredients) {
    // Adjuntar los ingredientes de cada receta mencionada para que el LLM pueda
    // hacer una lista de compras precisa en lugar de tener que inferirlos del título.
    const recipesWithIngredients: Record<string, string[]> = {};
    for (const day of weeklyPlan) {
      const titles = [day.breakfast, day.lunch, day.dinner];
      for (let i = 0; i < titles.length; i++) {
        const title = titles[i];
        if (title && recipeIngredients[title] && !recipesWithIngredients[title]) {
          recipesWithIngredients[title] = recipeIngredients[title];
        }
      }
    }
    if (Object.keys(recipesWithIngredients).length > 0) {
      humanContent += `\n\nA continuación los ingredientes de cada receta del plan (usa estos ingredientes para armar la lista de compras consolidada):\n\n${JSON.stringify(recipesWithIngredients, null, 2)}`;
    }
  }

  return {
    system: "Eres un asistente nutricional logístico. Lee el plan de comidas de 7 días adjunto y los ingredientes de cada receta. Extrae una lista de compras consolidada y exacta para la semana. Agrupa los ingredientes similares y suma las cantidades lógicas. Tu única tarea es devolver el JSON con la 'shoppingList'. Si un ingrediente aparece en varias recetas, consolídalo en una sola línea con la cantidad total. PROHIBIDO devolver un array vacío.",
    human: humanContent,
  };
}

// ── FASE 3 EN CÓDIGO (sin LLM) ──────────────────────────────
// La consolidación de la lista de compras es una tarea determinista:
// el plan semanal referencia recetas de la DB y cada receta tiene sus
// ingredientes. El LLM (deepseek) razona de forma masiva e impredecible
// en esta fase (hasta 26k tokens de razonamiento → timeout de 300s en
// Vercel). Generarla en código elimina el timeout de raíz y es más barato.

/** Unidades de medida que pueden aparecer tras la cantidad (singularizadas). */
const MEASURE_UNITS = new Set([
  "taza", "cucharada", "cucharadita", "cuchara", "g", "gr", "kg", "ml", "l",
  "litro", "diente", "hoja", "ramita", "rama", "pizca", "puñado", "vaso",
  "filete", "lata", "loncha", "rebanada", "unidad", "barra", "docena",
  "manojo", "cabeza", "sobre", "lata", "bolsa", "frasco", "tarro",
]);

/** Adjetivos de preparación que NO cambian el producto (se quitan para agrupar). */
const PREP_ADJECTIVES = [
  "en tiras", "en dados", "en cubos", "en virutas", "en juliana", "en escamas",
  "en rodajas", "en láminas", "en trozos", "en trocitos", "en bastones",
  "en bastoncitos", "en cuartos", "en gajos", "en mitades", "en aros",
  "en filetes", "al gusto", "sin hueso", "sin piel", "sin espinas",
  "para servir", "para guiso", "para cocinar", "mínima cantidad",
  "picado", "picada", "picados", "picadas", "rallado", "rallada", "rallados",
  "ralladas", "cortado", "cortada", "cortados", "cortadas", "molido",
  "molidos", "molida", "partido", "partida", "tostado", "tostada", "triturado",
  "triturada", "natural", "fresco", "fresca", "frescos", "frescas", "grande",
  "grandes", "pequeño", "pequeña", "pequeños", "pequeñas", "mediano",
  "mediana", "medianos", "medianas", "maduro", "madura", "maduros", "maduras",
  "duro", "dura", "duros", "duras", "escurrido", "escurrida", "ahumado",
  "ahumada", "ahumados", "entero", "entera", "enteros", "enteras", "crudo",
  "cruda", "cocido", "cocida", "cocidos", "cocidas", "asado", "asada",
  "seco", "seca", "secos", "secas", "laminado", "laminada", "congelado",
  "congelada", "descongelado", "descongelada", "rústico", "rústica",
  "recién", "opcional", "ecológico", "ecológica", "integral",
  "separado", "separada", "separados", "separadas", // "huevos separados"
  "en agua", "en aceite", // "atún en agua"
  "casero", "casera", "caseros", "caseras", // "mayonesa casera"
  "en lascas", "en polvo", // "queso parmesano en lascas"
  "verde", "verdes", "triguero", "trigueros", // "espárragos verdes/trigueros"
  "al horno", "a la plancha", "a la parrilla", "a la brasa", "salteado",
  "salteada", "hervido", "hervida", "pochado", "pochada", "escalfado",
  "escalfada", "macerado", "macerada", "marinado", "marinada", "carameliado",
  "caramelizada", "glasado", "glasada", "glaseado", "glaseada",
  "troceado", "troceada", "troceados", "troceadas", "partido", "partida",
  "fino", "fina", "finos", "finas", "grueso", "gruesa", "gruesos", "gruesas",
];

/** Ingredientes de despensa/básicos → prioridad baja. */
const LOW_PRIORITY_KEYWORDS = [
  "sal", "pimienta", "oregano", "comino", "pimenton", "canela", "laurel",
  "tomillo", "romero", "albahaca", "perejil", "hierba", "especia", "vinagre",
  "mostaza", "endulzante", "stevia", "levadura", "ajo en polvo", "curry",
];

/** Frescos/proteínas → prioridad alta. */
const HIGH_PRIORITY_KEYWORDS = [
  "carne", "pollo", "ternera", "cerdo", "pavo", "cordero", "pescado",
  "salmon", "atun", "sardina", "boqueron", "anchoa", "marisco", "gamba",
  "pulpo", "sepioneta", "calamar", "mejillon", "almeja", "cazon", "merluza",
  "dorada", "rodaballo", "lubina", "lenguado", "bacalao", "trucha", "sepia",
  "langostino", "cangrejo", "vieira", "huevo", "leche",
  "yogur", "queso", "feta", "halloumi", "ricotta", "mozzarella", "espinaca",
  "lechuga", "tomate", "pepino", "pimiento", "calabacin", "aguacate",
  "brocoli", "champinon", "manzana", "naranja", "platano", "limon", "lima",
  "fresa", "arandano", "frambuesa", "mora", "fruta", "kiwi", "pina",
  "mango", "pera", "uva", "zanahoria", "cebolla", "ajo", "calabaza",
  "berenjena", "coliflor", "brotes", "rúcula", "rucula", "canonigos",
];

interface ParsedIngredient {
  /** Cantidad numérica sumable (null si el texto no empieza con número). */
  quantity: number | null;
  /** Unidad de medida singularizada (null si no es una unidad conocida). */
  unit: string | null;
  /** Nombre limpio para mostrar (sin cantidad/unidad, con adjetivos). */
  displayName: string;
  /** Clave normalizada para agrupar ingredientes equivalentes. */
  groupKey: string;
  /** Texto original de la cantidad tal cual ("al gusto", "c/n", "1/4"...). */
  quantityText: string;
  alGusto: boolean;
}

/** Quita acentos y pasa a minúsculas. */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Singulariza un sustantivo en español de forma simplificada. */
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("es") && word.length > 4) {
    const base = word.slice(0, -2);
    // "nueces" → "nuez", "peces" → "pez", "raíces" → "raiz"
    if (/[c]$/.test(base)) return base + "z";
    // "dientes" → "diente", "guantes" → "guante", "clientes" → "cliente"
    if (word.endsWith("tes")) return word.slice(0, -1);
    // "flores" → "flor", "leones" → "leon": quitar "es"
    return base;
  }
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * Convierte "1/4", "2 1/2", "2-3" o "0.75" a número.
 * Los rangos toman el máximo (para no quedarse corto en la compra).
 */
function parseQuantity(raw: string): number | null {
  const t = raw.trim();
  const simple = /^(\d+(?:[.,]\d+)?)$/.exec(t);
  if (simple) return parseFloat(simple[1].replace(",", "."));
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac && parseInt(frac[2]) !== 0) return parseInt(frac[1]) / parseInt(frac[2]);
  const range = /^(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)$/.exec(t);
  if (range) return Math.max(parseFloat(range[1]), parseFloat(range[2]));
  return null;
}

/** Formatea un número como fracción bonita cuando aplica (0.25 → "1/4"). */
function formatQuantity(q: number): string {
  const EPS = 0.001;
  const whole = Math.floor(q + EPS);
  const frac = q - whole;
  if (Math.abs(frac) < EPS) return String(whole);
  const nice: Array<[number, string]> = [
    [1 / 4, "1/4"], [1 / 3, "1/3"], [1 / 2, "1/2"],
    [2 / 3, "2/3"], [3 / 4, "3/4"],
  ];
  for (const [v, s] of nice) {
    if (Math.abs(frac - v) < 0.05) return whole > 0 ? `${whole} ${s}` : s;
  }
  return (Math.round(q * 100) / 100).toString();
}

/** Pluraliza la unidad según la cantidad ("cucharada" → "cucharadas"). */
function pluralizeUnit(unit: string, q: number): string {
  if (q <= 1) return unit;
  if (["g", "gr", "kg", "ml", "l", "cl", "dl"].includes(unit)) return unit;
  return unit.endsWith("s") ? unit : unit + "s";
}

/** Prioridad heurística por tipo de ingrediente. */
function priorityForIngredient(displayName: string): "high" | "medium" | "low" {
  const n = normalizeText(displayName);
  if (HIGH_PRIORITY_KEYWORDS.some((k) => n.includes(k))) return "high";
  if (LOW_PRIORITY_KEYWORDS.some((k) => n.includes(k))) return "low";
  return "medium";
}

/** Parsea un string de ingrediente de la DB ("3 huevos grandes", "1/4 taza de X"). */
function parseIngredientString(raw: string): ParsedIngredient {
  const text = raw.trim();

  // ── Extraer cantidad inicial (número, fracción o rango) ──
  // OJO: la fracción mixta ("1 1/2") y la fracción ("1/4") deben evaluarse
  // ANTES que el número simple ("1"), si no "1 1/2 aguacate" se parsea como
  // cantidad 1 con el "1/2" pegado al nombre.
  const qtyMatch = /^((?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?))\s+(.+)$/.exec(text);
  let quantity: number | null = null;
  let quantityText = "";
  let rest = text;
  if (qtyMatch) {
    quantity = parseQuantity(qtyMatch[1]);
    quantityText = qtyMatch[1];
    rest = qtyMatch[2];
  }
  const alGusto = /al gusto|a gusto|c\/n/i.test(text);
  if (alGusto && quantity === null) quantityText = "al gusto";

  // Quitar sufijos "al gusto"/"c/n" del final (con o sin paréntesis),
  // tanto si la cantidad vino del número como si no:
  //   "aceite c/n" → "aceite" · "aceite (al gusto)" → "aceite"
  rest = rest.replace(/[,;]?\s*\(?\s*(al gusto|a gusto|c\/n)\s*\)?\s*$/i, "");

  // ── Quitar contexto entre paréntesis que NO es parte del producto ──
  // ("limón (jugo y rodajas)", "atún en agua (140 g escurrido)", "(150 g c/u)")
  rest = rest.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();

  // ── Quitar prefijos de porción "c/u" (cada unidad) ──
  rest = rest.replace(/^(?:c\/u|cada uno)\s*/i, "").trim();

  // ── Quitar unidad de medida si es conocida (singularizada) ──
  let unit: string | null = null;
  const unitMatch = /^([a-záéíóúüñ]+)\s+(?:de\s+)?(.+)$/i.exec(rest);
  if (unitMatch) {
    const candidate = singularize(normalizeText(unitMatch[1]));
    if (MEASURE_UNITS.has(candidate)) {
      unit = candidate;
      rest = unitMatch[2];
    }
  }

  // ── Limpiar preposiciones/artículos iniciales ──
  rest = rest.replace(/^(de|del|la|el|los|las|un|una|unos|unas)\s+/i, "");

  // ── Quitar puntuación final (".", ",") que ensucia el nombre ──
  rest = rest.replace(/[.,;]+$/g, "").trim();

  // ── Alternativas "A o B" → quedarse con la primera opción ──
  // ("queso parmesano o mozzarella", "corvina o lenguado")
  rest = rest.replace(/\s+o\s+[a-záéíóúüñ][a-záéíóúüñ\s]*$/i, "").trim();

  // ── Display: texto limpio (sin cantidad, sin unidad) con su forma original ──
  const displayName = rest.trim().replace(/\s+/g, " ");
  const normDisplay = normalizeText(displayName);

  // ── Key de agrupación: sin adjetivos de preparación, singularizada ──
  let key = normDisplay;
  for (const adj of PREP_ADJECTIVES) {
    // normalizeText porque la key ya está sin tildes y la adj puede tenerlas
    // ("pequeña", "rústica", "ecológica") — si no, el regex nunca matchea.
    key = key.replace(new RegExp(`\\b${normalizeText(adj).replace(/ /g, "\\s+")}\\b`, "g"), " ");
  }
  key = key.replace(/\s+/g, " ").trim();
  // Converger variantes de orden: "virgen extra" ↔ "extra virgen"
  key = key.replace(/\bextra virgen\b/g, "virgen extra");
  const keyWords = key.split(" ").filter(Boolean).map(singularize).join(" ");

  return {
    quantity,
    unit,
    displayName: displayName.charAt(0).toUpperCase() + displayName.slice(1),
    groupKey: `${keyWords}||${unit ?? ""}`,
    quantityText,
    alGusto,
  };
}

/**
 * Parsea un ingrediente que puede ser COMPUESTO con sub-receta embebida:
 *   "Salsa: 100 g de yogur griego, menta, ajo (c/n)"
 *   "Para la marinada: aceite, limón, ajo, pimentón, comino (c/n)"
 * Expande la sub-receta en sus componentes (cada uno como ingrediente propio).
 */
function parseIngredientStringList(raw: string): ParsedIngredient[] {
  const colonIdx = raw.indexOf(":");
  if (colonIdx !== -1) {
    const components = raw
      .slice(colonIdx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (components.length > 1) {
      // "Salsa: 100 g de yogur griego, menta, ajo" → ["100 g de yogur griego", "menta", "ajo"]
      return components.map((c) => parseIngredientString(c));
    }
  }
  return [parseIngredientString(raw)];
}

/**
 * Consolida ingredientes YA parseados en la lista de compras final
 * (agrupa por clave normalizada y serializa la cantidad total).
 */
function consolidateParsedIngredients(parsed: ParsedIngredient[]): ShoppingListOutput["shoppingList"] {
  // ── Consolidar por clave normalizada ──
  const groups = new Map<
    string,
    { displayName: string; unit: string | null; quantities: number[]; quantityTexts: string[] }
  >();
  for (const p of parsed) {
    const g = groups.get(p.groupKey);
    if (g) {
      if (p.quantity !== null) g.quantities.push(p.quantity);
      if (p.quantityText) g.quantityTexts.push(p.quantityText);
    } else {
      groups.set(p.groupKey, {
        displayName: p.displayName,
        unit: p.unit,
        quantities: p.quantity !== null ? [p.quantity] : [],
        quantityTexts: p.quantityText ? [p.quantityText] : [],
      });
    }
  }

  // ── Serializar la lista (orden alfabético, determinista) ──
  const shoppingList: Array<{ item: string; quantity: string; priority: "high" | "medium" | "low" }> = [];
  const sortedGroups = Array.from(groups.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  for (const g of sortedGroups) {
    let quantity: string;
    if (g.quantities.length > 0) {
      const total = g.quantities.reduce((a, b) => a + b, 0);
      quantity = g.unit ? `${formatQuantity(total)} ${pluralizeUnit(g.unit, total)}` : formatQuantity(total);
    } else {
      // Sin cantidad numérica: "c/n" (cantidad necesaria) = "al gusto".
      // Se muestra como "al gusto" para que el usuario no vea abreviaturas crípticas.
      quantity = "al gusto";
    }
    shoppingList.push({
      item: g.displayName,
      quantity,
      priority: priorityForIngredient(g.displayName),
    });
  }

  return shoppingList;
}

/**
 * Re-consolida items CRUDOS (p.ej. los que devuelve el LLM en el fallback):
 * "Mayonesa casera." + "Mayonesa (2 cucharadas)" → una sola línea.
 * Reconstruye el texto "cantidad + nombre" y lo pasa por el mismo parser
 * determinista del modo código.
 */
export function consolidateRawShoppingItems(
  rawItems: Array<{ item: string; quantity: string }>
): ShoppingListOutput["shoppingList"] {
  const parsed: ParsedIngredient[] = [];
  for (const r of rawItems) {
    const item = String(r.item ?? "").trim();
    const qty = String(r.quantity ?? "").trim();
    if (!item) continue;
    const text = qty && !/^(c\/n|al gusto|a gusto)$/i.test(qty) ? `${qty} ${item}` : item;
    parsed.push(...parseIngredientStringList(text));
  }
  return consolidateParsedIngredients(parsed);
}

/**
 * Construye la lista de compras consolidada EN CÓDIGO (sin LLM).
 * Requiere que todos los títulos del plan matcheen el mapa de ingredientes.
 */
export function buildShoppingListProgrammatically(
  weeklyPlan: Array<{ day: string; breakfast: string; lunch: string; dinner: string }>,
  recipeIngredients: Record<string, string[]>
): ShoppingListOutput {
  // ── 1. Recolectar ingredientes de todas las recetas del plan ──
  const parsed: ParsedIngredient[] = [];
  for (const day of weeklyPlan) {
    for (const meal of [day.breakfast, day.lunch, day.dinner]) {
      if (!meal) continue;
      const ingredients = recipeIngredients[meal];
      if (!ingredients) continue;
      for (const ing of ingredients) parsed.push(...parseIngredientStringList(ing));
    }
  }

  return { shoppingList: consolidateParsedIngredients(parsed) };
}

/**
 * Ejecuta la Fase 3 (Asistente Logístico) de forma independiente.
 * Toma un weeklyPlan y devuelve una shoppingList consolidada.
 * Útil para re-procesar la lista de compras cuando se edita el plan manualmente.
 */
export async function generateShoppingListFromWeeklyPlan(
  weeklyPlan: Array<{ day: string; breakfast: string; lunch: string; dinner: string }>,
  recipeIngredients?: Record<string, string[]>
): Promise<ShoppingListOutput> {
  logger.info("AI", "🛒 FASE 3 (standalone): Extrayendo lista de compras del plan semanal...", {
    planDays: weeklyPlan?.length ?? 0,
    recipeTitlesInPlan: Array.from(
      new Set((weeklyPlan ?? []).flatMap((d) => [d.breakfast, d.lunch, d.dinner].filter(Boolean))
    )).length,
    ingredientsMapEntries: recipeIngredients ? Object.keys(recipeIngredients).length : 0,
    ingredientsMapTotalItems: recipeIngredients
      ? Object.values(recipeIngredients).reduce((acc, list) => acc + (list?.length ?? 0), 0)
      : 0,
  });

  // ── Verificar que los títulos del plan existen en el mapa de ingredientes ──
  // Si FASE 2 generó títulos que NO coinciden exactamente con las recetas de la DB,
  // el modelo no tiene ingredientes reales y podría razonar/inventar de más.
  const planTitles = Array.from(
    new Set((weeklyPlan ?? []).flatMap((d) => [d.breakfast, d.lunch, d.dinner].filter(Boolean)))
  );
  const matchedTitles = planTitles.filter((t) => recipeIngredients?.[t] !== undefined);
  const unmatchedTitles = planTitles.filter((t) => recipeIngredients?.[t] === undefined);
  logger.info("AI", "FASE 3 (standalone): match títulos del plan vs recetas de la DB", {
    planTitlesCount: planTitles.length,
    matchedCount: matchedTitles.length,
    unmatchedCount: unmatchedTitles.length,
    unmatchedTitles: unmatchedTitles.slice(0, 10),
  });

  // ── MODO CÓDIGO (sin LLM): si TODOS los títulos matchean, la lista de
  // compras se consolida determinísticamente. El LLM razona de forma masiva
  // y no determinista en esta fase (hasta 26k tokens de razonamiento), lo que
  // excede los 300s de Vercel → timeout 504. El código lo elimina de raíz.
  if (unmatchedTitles.length === 0) {
    logger.info("AI", "FASE 3 (standalone): 100% de títulos matcheados → generando lista en código (sin LLM)", {
      planTitlesCount: planTitles.length,
      ingredientTotal: planTitles.reduce((acc, t) => acc + (recipeIngredients?.[t]?.length ?? 0), 0),
    });
    const result = buildShoppingListProgrammatically(weeklyPlan, recipeIngredients ?? {});
    logger.info("AI", "✅ Fase 3 (standalone) completada exitosamente (modo código, sin LLM).", {
      shoppingListItemCount: result.shoppingList.length,
      sampleItems: result.shoppingList.slice(0, 5),
    });
    return result;
  }

  // ── FALLBACK LLM (solo si hay títulos sin match): presupuesto ACOTADO a
  // 4000 tokens para limitar el razonamiento al mínimo posible. ──
  logger.info("AI", "FASE 3 (standalone): hay títulos sin match → usando LLM con maxTokens acotado (4000)", {
    unmatchedCount: unmatchedTitles.length,
  });

  // Safety delay para evitar rate limiting de Gemini
  await new Promise(resolve => setTimeout(resolve, 8000));

  const prompt = buildShoppingListPrompt(weeklyPlan, recipeIngredients);
  logger.info("AI", "FASE 3 (standalone): prompt construido", {
    systemChars: prompt.system.length,
    humanChars: prompt.human.length,
    humanPreview: prompt.human.substring(0, 400),
  });

  // maxTokens ACOTADO: el razonamiento de deepseek escala con el presupuesto;
  // 32000 tokens de razonamiento ≈ 9-15 min → timeout. Con 4000, el modelo
  // solo puede razonar unos segundos antes de responder.
  const content = await invokeLLM(prompt.system, prompt.human, "FASE 3 (standalone)", 4000);

  // Log del contenido crudo tal cual lo devolvió el LLM, ANTES de intentar parsear
  logger.info("AI", "FASE 3 (standalone): contenido crudo recibido del LLM", {
    chars: content.length,
    preview: content.substring(0, 400),
  });

  let result: ShoppingListOutput;
  try {
    result = robustJsonParse<ShoppingListOutput>(content);
  } catch (error: any) {
    logger.error("AI", "❌ Fase 3 (standalone) fallida: No se pudo parsear el JSON", error);
    throw new Error("Fase 3 fallida: El LLM no devolvió un JSON parseable para la lista de compras. " + (error?.message || ""));
  }

  // Sanitizar items: asegurar que todos tengan item, quantity y priority con valores válidos.
  // El modelo a veces devuelve claves en español (ingrediente/cantidad/prioridad) y otras
  // en inglés (item/quantity/priority) — aceptamos AMBOS idiomas sin tocar los prompts.
  if (Array.isArray(result.shoppingList)) {
    const originalCount = result.shoppingList.length;
    result.shoppingList = result.shoppingList
      .filter((item: any) => item && (item.item || item.name || item.ingredient || item.ingrediente))
      .map((item: any) => ({
        item: String(item.item ?? item.name ?? item.ingredient ?? item.ingrediente ?? ''),
        quantity: String(item.quantity ?? item.amount ?? item.cantidad ?? ''),
        priority: (['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium') as 'high' | 'medium' | 'low',
      }));
    logger.info("AI", "FASE 3 (standalone): items sanitizados", {
      originalCount,
      sanitizedCount: result.shoppingList.length,
    });

    // ── POST-PROCESO DETERMINISTA ──
    // El LLM con maxTokens acotado (4000) tiende a copiar los ingredientes
    // literalmente: duplicados ("Mayonesa" + "Mayonesa casera."), cantidades
    // "c/n" sin interpretar, sub-recetas embebidas ("Salsa: 100 g de yogur
    // griego, menta, ajo (c/n)"), puntuación sucia, etc. Se re-consolida con
    // el MISMO parser determinista del modo código → lista limpia y sumada.
    const rawForConsolidation = result.shoppingList.map((i) => ({ item: i.item, quantity: i.quantity }));
    const consolidated = consolidateRawShoppingItems(rawForConsolidation);
    logger.info("AI", "FASE 3 (standalone): items re-consolidados en código", {
      before: result.shoppingList.length,
      after: consolidated.length,
      removedDuplicates: result.shoppingList.length - consolidated.length,
      sampleItems: consolidated.slice(0, 5),
    });
    result.shoppingList = consolidated;
  }

  // Guardia Fail-Fast: lista de compras debe ser un array con al menos 1 elemento
  if (!result.shoppingList || !Array.isArray(result.shoppingList) || result.shoppingList.length === 0) {
    logger.error("AI", "❌ Fase 3 (standalone) fallida: Lista de compras inválida o vacía.", new Error("Invalid or empty shopping list"));
    throw new Error("Fase 3 fallida: El LLM no pudo consolidar la lista de compras. Abortando pipeline.");
  }

  logger.info("AI", "✅ Fase 3 (standalone) completada exitosamente.", {
    shoppingListItemCount: result.shoppingList.length,
  });

  return result;
}

// ── Helpers de invocación LLM ──────────────────────────────

async function invokeLLM(
  systemMsg: string,
  humanMsg: string,
  phaseLabel: string,
  maxTokens?: number
): Promise<string> {
  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const logCtx = logger.withContext({ phase: phaseLabel });

  // ── Reintento por presupuesto agotado en razonamiento ──
  // deepseek-v4-flash razona ANTES de responder y el razonamiento consume del
  // maxTokens. Si el presupuesto es bajo (FASE 1/3 usan 4000), el modelo puede
  // gastarlo TODO en reasoning_content y devolver content VACÍO (0 chars) con
  // finishReason='length' → robustJsonParse('') falla → "Fase 1 fallida".
  // Fix: reintentar escalando maxTokens (4000 → 8000 → 16000) hasta obtener
  // contenido no vacío. Evita falsos fallos con clientes/complejidad alta.
  const MAX_LLM_ATTEMPTS = 3;
  const attemptTokens = (attempt: number) =>
    Math.min(32000, (maxTokens ?? 16000) * Math.pow(2, attempt));

  let lastMetadata: Record<string, unknown> | null = null;
  let lastContent = '';

  for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
    const tokens = attempt === 0 ? (maxTokens ?? 16000) : attemptTokens(attempt);
    const attemptStart = Date.now();

    logCtx.info("AI", `${phaseLabel}: Iniciando llamada LLM (intento ${attempt + 1}/${MAX_LLM_ATTEMPTS})`, {
      startedAt,
      attempt,
      maxTokens: tokens,
      systemChars: systemMsg.length,
      humanChars: humanMsg.length,
      totalChars: systemMsg.length + humanMsg.length,
    });

    const llm = await createDeepSeekJSONLLM({ maxTokens: tokens });
    const modelUsed =
      (llm as any)?.modelName || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

    let response: any;
    try {
      response = await llm.invoke([
        new SystemMessage(systemMsg),
        new HumanMessage(humanMsg),
      ]);
    } catch (error: any) {
      const elapsedMs = Date.now() - attemptStart;
      logCtx.error("AI", `${phaseLabel}: llm.invoke LANZÓ ERROR (intento ${attempt + 1})`, error, {
        startedAt,
        elapsedMs,
        modelUsed,
        errorName: error?.name,
        errorCode: error?.code,
        errorStatus: error?.status,
        errorType: error?.error?.type,
        errorMessage: error?.message?.substring(0, 500),
      });
      if (attempt === MAX_LLM_ATTEMPTS - 1) throw error;
      continue; // error transitorio → reintentar
    }

    const elapsedMs = Date.now() - attemptStart;
    const content = typeof response?.content === "string" ? response.content : "";
    lastContent = content;
    const finishReason =
      response?.response_metadata?.finishReason ??
      response?.response_metadata?.finish_reason ??
      null;
    const metadata = {
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs,
      attempt,
      modelUsed,
      finishReason,
      usage:
        response?.usage_metadata ??
        response?.response_metadata?.usage ??
        null,
      outputTokenDetails:
        response?.usage_metadata?.output_token_details ??
        response?.response_metadata?.usage?.output_token_details ??
        null,
      inputTokenDetails:
        response?.usage_metadata?.input_token_details ??
        response?.response_metadata?.usage?.input_token_details ??
        null,
      reportedModel:
        response?.response_metadata?.model ??
        response?.response_metadata?.model_name ??
        null,
      additionalKwargsPreview: response?.additional_kwargs
        ? JSON.stringify(response.additional_kwargs)?.substring(0, 600)
        : null,
      responseMetadataFull: response?.response_metadata
        ? JSON.stringify(response.response_metadata)?.substring(0, 600)
        : null,
      responseContentType: typeof response?.content,
      responseKeys: response ? Object.keys(response) : [],
    };
    lastMetadata = metadata;

    if (content.length > 0) {
      logCtx.info("AI", `${phaseLabel}: LLM respondió con ${content.length} caracteres`, {
        ...metadata,
        contentPreview: content.substring(0, 120),
      });
      return content;
    }

    // Contenido vacío: el modelo reasoner agotó el presupuesto razonando.
    // Reintentar con MÁS tokens (solo si hay margen de intentos).
    logCtx.warn("AI", `${phaseLabel}: LLM respondió con contenido VACÍO (0 chars) — reintentando con más tokens`, {
      ...metadata,
      contentNonStringPreview:
        typeof response?.content !== "string"
          ? JSON.stringify(response?.content)?.substring(0, 300)
          : null,
      rawResponsePreview: JSON.stringify(response)?.substring(0, 1200),
    });
  }

  // Si llegamos aquí: agotamos reintentos con contenido vacío
  logCtx.error("AI", `${phaseLabel}: LLM devolvió vacío tras ${MAX_LLM_ATTEMPTS} intentos con maxTokens escalado`, undefined, {
    lastMetadata,
  });
  return lastContent; // vacío — el caller hará robustJsonParse('') y fallará con mensaje claro
}

// ── Orquestador Principal (Pipeline Secuencial) ────────────

export type CompositeOutputWithIds = CompositeOutput & {
  _recipeIds: Record<string, string>;
  _exerciseIds: Record<string, string>;
};

export async function generateCompositeRecommendation(input: CompositeInput): Promise<CompositeOutputWithIds> {
  logger.info("AI", "Iniciando pipeline secuencial de recomendaciones (3 fases)");

  // ── 0. Obtener recetas y ejercicios de la DB ──
  const { getRecipesCollection, getExerciseCollection } = await import("./database");
  const { decrypt: dbDecrypt } = await import("./encryption");

  const recipesColl = await getRecipesCollection();
  const recipeDocs = await recipesColl.find({ isPublished: true }).limit(80).toArray();
  const dbRecipes = recipeDocs.map((d) => ({
    _id: String(d._id),
    title: dbDecrypt(d.title as string),
    cookTime: d.cookTime as number,
    difficulty: dbDecrypt((d.difficulty as string) || 'easy'),
    category: ((d.category as string[]) || []).map((c: string) => dbDecrypt(c)),
    ingredients: ((d.ingredients as string[]) || []).map((i: string) => dbDecrypt(i)),
  }));
  logger.info("AI", `${dbRecipes.length} recetas obtenidas de la DB`);

  const exercisesColl = await getExerciseCollection();
  const exerciseDocs = await exercisesColl.find({ isPublished: true }).limit(80).toArray();
  const dbExercises = exerciseDocs.map((d) => ({
    _id: String(d._id),
    name: dbDecrypt(d.name as string),
    difficulty: dbDecrypt((d.difficulty as string) || 'medium'),
    clientLevel: dbDecrypt((d.clientLevel as string) || 'principiante'),
    equipment: ((d.equipment as string[]) || []).map((e: string) => dbDecrypt(e)),
    muscleGroups: ((d.muscleGroups as string[]) || []).map((m: string) => dbDecrypt(m)),
  }));
  logger.info("AI", `${dbExercises.length} ejercicios obtenidos de la DB`);

  const hasDocuments = input.processedDocuments && input.processedDocuments.length > 0;

  // ══════════════════════════════════════════════════════════
  // FASE 1: Analista Clínico — Extracción médica aislada
  // ══════════════════════════════════════════════════════════

  logger.info("AI", "🔬 FASE 1: Iniciando análisis médico...");
  const medicalPrompt = buildMedicalPrompt(input);
  // maxTokens 32000 (antes 4000/8000): deepseek-v4-flash es modelo REASONER —
  // el razonamiento consume del presupuesto y casos con documentos médicos
  // necesitan ~12-18K tokens de salida (medido en prod 2026-09-04: reasoning
  // 11688 + respuesta 6200). Con presupuesto bajo el modelo agotaba TODO en
  // reasoning_content y devolvía content vacío (finishReason='length').
  // Empezar en 32000 evita quemar 2 intentos fallidos (~200s) dentro de la
  // ventana de 300s del worker de Vercel.
  const medicalContent = await invokeLLM(medicalPrompt.system, medicalPrompt.human, "FASE 1", 32000);

  let medicalResult: MedicalOutput;
  try {
    medicalResult = robustJsonParse<MedicalOutput>(medicalContent);
  } catch (error: any) {
    logger.error("AI", "❌ Fase 1 fallida: No se pudo parsear el JSON médico", error);
    throw new Error("Fase 1 fallida: El LLM no devolvió un JSON parseable para el análisis médico. " + (error?.message || ""));
  }

  // Validación FAIL-FAST: si hay documentos y exams está vacío
  if (hasDocuments && (!medicalResult.structuredMedicalAnalysis?.exams || medicalResult.structuredMedicalAnalysis.exams.length === 0)) {
    logger.error("AI", "❌ Fase 1 fallida: El modelo médico no extrajo las tablas.", new Error("Medical model failed to extract tables"));
    throw new Error("Fase 1 fallida: El modelo médico no extrajo las tablas de biomarcadores. Abortando pipeline.");
  }

  logger.info("AI", "✅ Fase 1 (Análisis Médico) completada exitosamente.", {
    examCount: medicalResult.structuredMedicalAnalysis?.exams?.length ?? 0,
    supplementCount: medicalResult.structuredMedicalAnalysis?.supplements?.length ?? 0,
    labResultCount: medicalResult.labResults?.length ?? 0,
  });

  // ══════════════════════════════════════════════════════════
  // DELAY DE SEGURIDAD: 8 segundos entre fases (evitar 503)
  // ══════════════════════════════════════════════════════════

  await new Promise(resolve => setTimeout(resolve, 8000));

  // ══════════════════════════════════════════════════════════
  // FASE 2: Health Coach — Plan de estilo de vida
  // ══════════════════════════════════════════════════════════

  logger.info("AI", "🏋️ FASE 2: Iniciando plan de estilo de vida...");
  const lifestylePrompt = buildLifestylePrompt(input, dbRecipes, dbExercises, medicalResult);
  const lifestyleContent = await invokeLLM(lifestylePrompt.system, lifestylePrompt.human, "FASE 2", 32000);

  let lifestyleResult: LifestyleOutput;
  try {
    lifestyleResult = robustJsonParse<LifestyleOutput>(lifestyleContent);
  } catch (error: any) {
    logger.error("AI", "❌ Fase 2 fallida: No se pudo parsear el JSON de estilo de vida", error);
    throw new Error("Fase 2 fallida: El LLM no devolvió un JSON parseable para el plan de estilo de vida. " + (error?.message || ""));
  }

  // Validación FAIL-FAST de estructura: el weeklyPlan es REQUERIDO para la Fase 3.
  // Si el LLM se cortó (finish_reason='length') el JSON puede parsear pero venir
  // incompleto — fallar con mensaje claro en vez de un TypeError `reading 'weeklyPlan'`.
  const weeklyPlan = lifestyleResult?.nutritionPlan?.weeklyPlan;
  if (!weeklyPlan || !Array.isArray(weeklyPlan) || weeklyPlan.length === 0) {
    logger.error("AI", "❌ Fase 2 fallida: weeklyPlan ausente o vacío (¿JSON truncado por finish_reason='length'?)", new Error("Missing or empty weeklyPlan"));
    throw new Error("Fase 2 fallida: El plan de nutrición semanal está vacío o incompleto. Reintenta la generación.");
  }

  logger.info("AI", "✅ Fase 2 (Plan de Estilo de Vida) completada exitosamente.", {
    nutritionDays: weeklyPlan.length,
    exerciseDays: lifestyleResult.exercisePlan?.weeklyRoutine?.length ?? 0,
    habitCount: lifestyleResult.habitPlan?.toAdopt?.length ?? 0,
  });

  // ══════════════════════════════════════════════════════════
  // FASE 3: Asistente Logístico — Lista de compras del weeklyPlan
  // ══════════════════════════════════════════════════════════

  // ── Mapa título → ingredientes (para Fase 3) ──
  const recipeIngredients: Record<string, string[]> = {};
  for (const rec of dbRecipes) {
    recipeIngredients[rec.title] = rec.ingredients;
  }
  logger.info("AI", "FASE 3: mapa título→ingredientes construido", {
    recipesInMap: Object.keys(recipeIngredients).length,
    sampleTitles: Object.keys(recipeIngredients).slice(0, 5),
    sampleIngredients: Object.values(recipeIngredients).slice(0, 2),
  });

  const shoppingListResult = await generateShoppingListFromWeeklyPlan(
    lifestyleResult.nutritionPlan.weeklyPlan,
    recipeIngredients
  );

  // ══════════════════════════════════════════════════════════
  // FUSIÓN FINAL: Combinar Fase 1 + Fase 2 + Fase 3 en CompositeOutput
  // ══════════════════════════════════════════════════════════

  const result: CompositeOutput = {
    clientInsights: {
      ...lifestyleResult.clientInsights,
      medicalSummary: medicalResult.medicalSummary,
      medicalComparativeAnalysis: medicalResult.medicalComparativeAnalysis,
      labResults: medicalResult.labResults,
      structuredMedicalAnalysis: medicalResult.structuredMedicalAnalysis,
    },
    nutritionPlan: {
      ...lifestyleResult.nutritionPlan,
      shoppingList: Array.isArray(shoppingListResult?.shoppingList) ? shoppingListResult.shoppingList : [],
    },
    exercisePlan: lifestyleResult.exercisePlan,
    habitPlan: lifestyleResult.habitPlan,
    alternatives: lifestyleResult.alternatives,
  };

  // Validaciones de estructura mínima (throw si faltan secciones críticas)
  if (!result.clientInsights.summary) {
    throw new Error("Fusión fallida: clientInsights.summary está vacío tras combinar ambas fases.");
  }
  if (!result.clientInsights.vision) {
    throw new Error("Fusión fallida: clientInsights.vision está vacío tras combinar ambas fases.");
  }
  if (!result.nutritionPlan || !result.nutritionPlan.weeklyPlan || result.nutritionPlan.weeklyPlan.length < 7) {
    throw new Error("Fusión fallida: nutritionPlan.weeklyPlan tiene menos de 7 días tras combinar ambas fases.");
  }

  logger.info("AI", "✅ Pipeline secuencial (3 fases) completado exitosamente", {
    hasMedicalAnalysis: (result.clientInsights.structuredMedicalAnalysis?.exams?.length ?? 0) > 0,
    examCount: result.clientInsights.structuredMedicalAnalysis?.exams?.length ?? 0,
    supplementCount: result.clientInsights.structuredMedicalAnalysis?.supplements?.length ?? 0,
    nutritionDays: result.nutritionPlan.weeklyPlan.length,
    shoppingListItemCount: result.nutritionPlan.shoppingList.length,
  });

  // ── Mapeo directo título → ID ──
  const recipeIds: Record<string, string> = {};
  const exerciseIds: Record<string, string> = {};
  for (const rec of dbRecipes) { recipeIds[rec.title] = rec._id; }
  for (const ex of dbExercises) { exerciseIds[ex.name] = ex._id; }

  return { ...result, _recipeIds: recipeIds, _exerciseIds: exerciseIds } as CompositeOutputWithIds;
}
