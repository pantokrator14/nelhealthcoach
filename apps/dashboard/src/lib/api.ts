import { AIRecommendationSession, ChecklistItem } from '../../../../packages/types/src/healthForm';
import { Recipe, RecipeFormData, RecipeImage } from '../../../../packages/types/src/recipe-types';
import { NutritionAnalysisResult } from '../../../../packages/types/src/nutrition-types';
import { clearAuthToken } from './authSession';

export interface Exercise {
  id: string;
  name: string;
  description: string;
  category: string[];
  instructions: string[];
  equipment: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  clientLevel: 'principiante' | 'intermedio' | 'avanzado';
  muscleGroups: string[];
  contraindications: string[];
  sets: number;
  repetitions: string;
  timeUnderTension: string;
  restBetweenSets: string;
  progression: string;
  demo: {
    url: string;
    key: string;
    type: string;
    name: string;
    size: number;
    uploadedAt: string;
    videoSearchUrl?: string;
  } | null;
  progressionOf: string | null;
  progressesTo: string[];
  // Nombres resueltos por el backend (para mostrar en el frontend sin ObjectIds)
  progressionOfName?: string | null;
  progressesToNames?: string[];
  isPublished: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExerciseFormData {
  name: string;
  description: string;
  category: string[];
  instructions: string[];
  equipment: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  clientLevel: 'principiante' | 'intermedio' | 'avanzado';
  muscleGroups: string[];
  contraindications?: string[];
  sets: number;
  repetitions: string;
  timeUnderTension: string;
  restBetweenSets: string;
  progression: string;
  demo?: {
    url: string;
    key: string;
    type: string;
    name: string;
    size: number;
    uploadedAt: string;
    videoSearchUrl?: string;
  };
  progressionOf?: string | null;
  progressesTo?: string[];
  isPublished?: boolean;
  tags: string[];
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * Crea un Error a partir del payload de error de la API adjuntando el `code`
 * para que translateApiError() pueda mostrar el mensaje localizado correcto.
 * El message crudo (español técnico) nunca debe mostrarse directo al usuario.
 */
function apiError(
  payload: { message?: string; code?: string } | null | undefined,
  fallback: string
): Error {
  const err = new Error(payload?.message || fallback);
  (err as Error & { code?: string }).code = payload?.code;
  return err;
}


interface CreateChecklistItemData {
  weekNumber: number;
  category: 'nutrition' | 'exercise' | 'habit' | 'medical' | 'supplement';
  data: {
    description: string;
    type?: string;
    frequency?: number;
    recipeId?: string;
    details?: {
      frequency?: string;
      duration?: string;
      equipment?: string[];
      recipe?: {
        ingredients: Array<{name: string; quantity: string; notes?: string}>;
        preparation: string;
        tips?: string;
      };
    };
  };
}

interface UpdateChecklistItemData {
  description?: string;
  frequency?: number;
  recipeId?: string;
  details?: {
    frequency?: string;
    duration?: string;
    equipment?: string[];
    recipe?: {
      ingredients: Array<{name: string; quantity: string; notes?: string}>;
      preparation: string;
      tips?: string;
    };
  };
}

interface ImportableAISessionData {
  summary?: string;
  vision?: string;
  weeks?: unknown[];
  checklist?: unknown[];
  coachNotes?: string;
  monthNumber?: number;
  status?: 'draft' | 'approved' | 'sent';
  baselineMetrics?: {
    currentWeight?: number;
    targetWeight?: number;
    currentLifestyle?: string[];
    targetLifestyle?: string[];
  };
  [key: string]: unknown;
}

interface Client {
  id: string;
  name: string;
  email: string;
  phone?: string;
}

interface ApiResponse<T> {
  data: T;
  status: number;
  success: boolean;
  message?: string;
}

// Eliminada: interface UploadRequest no utilizada

interface UploadResponse {
  uploadURL: string;
  fileKey: string;
  fileURL?: string;
}

interface AIRecommendationRequest {
  monthNumber: number;
  reprocessDocuments: boolean;
  coachNotes: string;
}

interface AIProgressResponse {
  success: boolean;
  data: {
    hasAIProgress: boolean;
    aiProgress: {
      sessions?: Array<{
        sessionId: string;
        summary?: string;
        vision?: string;
        weeks?: Array<{
          habits?: {
            checklistItems?: ChecklistItem[];
          };
        }>;
      }>;
    };
    generationError?: {
      message: string;
      monthNumber?: number;
      timestamp?: string;
    };
  };
}

interface AIActionRequest {
  action: string;
  sessionId: string;
  data?: {
    checklistItems?: ChecklistItem[];
    coachNotes?: string;
  };
}

const getAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    // FingerprintJS visitor ID para rate limiting por dispositivo y bot detection
    const visitorId = localStorage.getItem('nel_fp_visitor_id');
    if (visitorId) {
      headers['X-Visitor-Id'] = visitorId;
    }
  }
  return headers;
};

export interface FinancesData {
  isAdmin: boolean;
  summary: {
    totalBruto: number;
    totalSuscripcion: number;
    totalObtenido: number;
    totalPayouts: number;
    sesionesCompletadas: number;
  };
  sesionPrice: number;
  sesionPriceFijo: boolean;
  transaccionesRecientes: Array<{
    id: string;
    clientName: string;
    amount: number;
    date: string;
    status: string;
  }>;
  breakdownMensual: Array<{
    month: string;
    ingresos: number;
    suscripcion: number;
  }>;
  suscripcion: {
    status: string;
    monto: number;
    proximoCobro: string | null;
    mesesSuscrito: number;
    currentPeriodEnd: string | null;
  } | null;
  payouts: Array<{
    id: string;
    amount: number;
    status: string;
    arrivalDate: string;
    description: string;
  }>;
}

export const apiClient = {
  async login(credentials: { email: string; password: string }) {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error en el login');
    }

    return response.json();
  },

  async getClients() {
    const response = await fetch(`${API_BASE_URL}/api/clients`, {
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthToken();
        window.location.href = '/login';
      }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al cargar clientes');
    }
    return response.json();
  },

  async getClient(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/clients/${id}`, {
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthToken();
        window.location.href = '/login';
      }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al cargar cliente');
    }
    return response.json();
  },

  async updateClient(id: string, data: Partial<Client>): Promise<ApiResponse<Client>> {
    console.log('🔄 Enviando actualización para cliente:', id, data);

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
      });

      const responseData = await response.json();

      if (!response.ok) {
        console.error('❌ Error del servidor:', responseData);
        throw apiError(responseData, `Error ${response.status} al actualizar cliente`);
      }

      console.log('✅ Actualización exitosa:', responseData);
      return responseData as ApiResponse<Client>;

    } catch (error) {
      console.error('❌ Error en updateClient:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al actualizar cliente');
    }
  },

  async deleteClient(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/clients/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al eliminar cliente');
    }
    return response.json();
  },

  async getStats() {
    const response = await fetch(`${API_BASE_URL}/api/stats`, {
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthToken();
        window.location.href = '/login';
      }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al cargar estadísticas');
    }
    return response.json();
  },

  async generateUploadURL(
    clientId: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    fileCategory: 'profile' | 'document'
  ): Promise<UploadResponse> {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/upload`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        fileName,
        fileType,
        fileSize,
        fileCategory
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error generando URL de upload');
    }
    const responseData = await response.json();
    return {
      uploadURL: responseData.data?.uploadURL || responseData.uploadURL,
      fileKey: responseData.data?.fileKey || responseData.fileKey,
      fileURL: responseData.data?.fileURL || responseData.fileURL,
    } as UploadResponse;
  },

  async confirmUpload(
    clientId: string,
    fileKey: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    fileCategory: 'profile' | 'document',
    fileURL: string
  ): Promise<ApiResponse<unknown>> {
    console.log('🔵 Confirmando upload:', { clientId, fileName, fileKey });

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/upload`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          fileKey,
          fileName,
          fileType,
          fileSize,
          fileCategory,
          fileURL
        }),
      });

      const responseData = await response.json();
      console.log('🔵 Respuesta de confirmación:', responseData);

      if (!response.ok) {
        throw apiError(responseData, `Error ${response.status} confirmando upload`);
      }

      return responseData as ApiResponse<unknown>;

    } catch (error) {
      console.error('❌ Error en confirmUpload:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error confirmando upload');
    }
  },

  async getDocumentDownloadURL(clientId: string, fileKey: string): Promise<string> {
    const response = await fetch(
      `${API_BASE_URL}/api/clients/${clientId}/upload?fileKey=${encodeURIComponent(fileKey)}`,
      { headers: getAuthHeaders() }
    );
    const data = await response.json();
    if (data.success && data.data?.downloadURL) return data.data.downloadURL;
    throw apiError(data, 'Error obteniendo URL de descarga');
  },

  async checkExtractionStatus(clientId: string, fileKey: string): Promise<'pending' | 'completed' | 'failed'> {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/clients/${clientId}/upload?fileKey=${encodeURIComponent(fileKey)}&checkExtraction=true`,
        { headers: getAuthHeaders() }
      );
      const data = await response.json();
      if (data.success && data.data?.extractionStatus) {
        return data.data.extractionStatus as 'pending' | 'completed' | 'failed';
      }
      return 'pending';
    } catch {
      return 'pending';
    }
  },

  async deleteDocument(clientId: string, fileKey: string): Promise<ApiResponse<unknown>> {
    console.log('🗑️ Eliminando documento:', { clientId, fileKey });

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/upload`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
        body: JSON.stringify({ fileKey }),
      });

      const responseData = await response.json();
      console.log('🗑️ Respuesta de eliminación:', responseData);

      if (!response.ok) {
        throw apiError(responseData, `Error ${response.status} eliminando documento`);
      }

      return responseData as ApiResponse<unknown>;
    } catch (error) {
      console.error('❌ Error en deleteDocument:', error);
      throw error;
    }
  },

  // Métodos para IA
  async generateAIRecommendations(
    clientId: string,
    monthNumber: number = 1,
    reprocessDocuments: boolean = false,
    coachNotes: string = ''
  ): Promise<ApiResponse<unknown>> {
    console.log('🚀 generateAIRecommendations llamado:', {
      clientId,
      monthNumber,
      API_BASE_URL,
      endpoint: `${API_BASE_URL}/api/clients/${clientId}/ai`
    });

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          monthNumber,
          reprocessDocuments,
          coachNotes
        } as AIRecommendationRequest),
      });

      console.log('📡 Response status:', response.status);
      console.log('📡 Response headers:', Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Error response:', errorText);
        let errorData: { message?: string };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText || 'Error desconocido' };
        }
        throw apiError(errorData, 'Error generando recomendaciones de IA');
      }

      const data = await response.json();
      console.log('✅ Response data:', data);
      return data as ApiResponse<unknown>;

    } catch (error) {
      console.error('💥 Error en generateAIRecommendations:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al generar recomendaciones de IA');
    }
  },

  async getAIProgress(clientId: string): Promise<AIProgressResponse> {
    console.log('🔍 getAIProgress llamado para cliente:', clientId);

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
        headers: getAuthHeaders(),
      });

      console.log('📡 Status de getAIProgress:', response.status);

      if (!response.ok) {
        if (response.status === 401) {
          clearAuthToken();
          window.location.href = '/login';
        }
        const errorData = await response.json().catch(() => ({}));
        throw apiError(errorData, 'Error al cargar progreso de IA');
      }

      const result = await response.json();
      console.log('📦 Respuesta completa getAIProgress:', {
        success: result.success,
        hasData: !!result.data,
        hasAIProgress: result.data?.hasAIProgress,
        sessions: result.data?.aiProgress?.sessions?.length || 0,
        generationError: result.data?.generationError?.message || null,
        firstSession: result.data?.aiProgress?.sessions?.[0] ? {
          sessionId: result.data.aiProgress.sessions[0].sessionId,
          summary: result.data.aiProgress.sessions[0].summary?.substring(0, 50),
          vision: result.data.aiProgress.sessions[0].vision?.substring(0, 50),
          weeks: result.data.aiProgress.sessions[0].weeks?.length || 0,
          week1Habits: result.data.aiProgress.sessions[0].weeks?.[0]?.habits?.checklistItems?.length || 0
        } : null
      });

      return result as AIProgressResponse;

    } catch (error) {
      console.error('💥 Error en getAIProgress:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al cargar progreso de IA');
    }
  },

  updateSessionItems: async (
    clientId: string,
    sessionId: string,
    checklistItems: ChecklistItem[]
  ): Promise<ApiResponse<unknown>> => {
    console.log('📝 Enviando checklist al backend...');

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action: 'update_checklist',
          sessionId,
          data: { checklistItems }
        } as AIActionRequest),
      });

      const responseData = await response.json();
      console.log('📦 Respuesta completa:', responseData);

      if (!response.ok) {
        throw apiError(responseData, `Error ${response.status}`);
      }

      return responseData as ApiResponse<unknown>;

    } catch (error) {
      console.error('💥 Error en updateSessionItems:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al actualizar checklist de IA');
    }
  },

  async approveAISession(clientId: string, sessionId: string): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        action: 'approve_session',
        sessionId
      } as AIActionRequest),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error aprobando sesión');
    }
    return response.json() as Promise<ApiResponse<unknown>>;
  },

  async sendAISessionToClient(clientId: string, sessionId: string): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        action: 'send_to_client',
        sessionId
      } as AIActionRequest),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error enviando sesión al cliente');
    }
    return response.json() as Promise<ApiResponse<unknown>>;
  },

  async regenerateAISession(
    clientId: string,
    sessionId: string,
    coachNotes: string = ''
  ): Promise<ApiResponse<unknown>> {
    console.log('🔄 regenerateAISession llamado:', {
      clientId,
      sessionId,
      hasCoachNotes: !!coachNotes && coachNotes.trim().length > 0
    });

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action: 'regenerate_session',
          sessionId,
          data: {
            coachNotes: coachNotes || ''
          }
        } as AIActionRequest),
      });

      console.log('📡 Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Error response:', errorText);
        let errorData: { message?: string; code?: string };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText || 'Error desconocido' };
        }
        // Adjuntar el código de error de la API para que la UI pueda traducirlo
        // (translateApiError). El message crudo NO debe mostrarse al usuario.
        throw apiError(errorData, 'Error regenerando sesión');
      }

      const data = await response.json();
      console.log('✅ Regeneración exitosa:', data);
      return data as ApiResponse<unknown>;

    } catch (error) {
      console.error('💥 Error en regenerateAISession:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al regenerar sesión de IA');
    }
  },

  async importAISession(
    clientId: string,
    sessionData: ImportableAISessionData,
    monthNumber: number = 1
  ): Promise<ApiResponse<unknown>> {
    console.log('📤 importAISession llamado:', {
      clientId,
      monthNumber,
      sessionDataKeys: Object.keys(sessionData)
    });

    try {
      const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action: 'import_session',
          sessionId: '', // El backend generará uno nuevo
          data: {
            sessionData,
            monthNumber
          }
        } as AIActionRequest),
      });

      console.log('📡 Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Error response:', errorText);
        let errorData: { message?: string };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText || 'Error desconocido' };
        }
        throw apiError(errorData, 'Error importando sesión de IA');
      }

      const data = await response.json();
      console.log('✅ Importación exitosa:', data);
      return data as ApiResponse<unknown>;

    } catch (error) {
      console.error('💥 Error en importAISession:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al importar sesión de IA');
    }
  },

  async extractTextFromFile(file: File): Promise<ApiResponse<{ extractedText: string; fileName: string; fileType: string; fileSize: number; extractedLength: number }>> {
    console.log('📄 extractTextFromFile llamado:', {
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size
    });

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API_BASE_URL}/api/extract-text`, {
        method: 'POST',
        body: formData,
        // No incluir Content-Type header, FormData lo establece automáticamente con boundary
      });

      console.log('📡 Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Error response:', errorText);
        let errorData: { message?: string };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText || 'Error desconocido' };
        }
        throw apiError(errorData, 'Error extrayendo texto del archivo');
      }

      const data = await response.json();
      console.log('✅ Texto extraído exitosamente:', {
        fileName: data.data?.fileName,
        extractedLength: data.data?.extractedLength
      });
      return data as ApiResponse<{ extractedText: string; fileName: string; fileType: string; fileSize: number; extractedLength: number }>;

    } catch (error) {
      console.error('💥 Error en extractTextFromFile:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error desconocido al extraer texto del archivo');
    }
  },

  // Métodos para Recetas - Tipos corregidos
  async getRecipes(search?: string, category?: string): Promise<ApiResponse<Recipe[]>> {
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (category) params.append('category', category);

    const query = params.toString() ? `?${params.toString()}` : '';
    const response = await fetch(`${API_BASE_URL}/api/recipes${query}`, {
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthToken();
        window.location.href = '/login';
      }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al cargar recetas');
    }
    return response.json();
  },

  async generateRecipeUploadURL(
    recipeId: string,
    fileName: string,
    fileType: string,
    fileSize: number
  ): Promise<UploadResponse> {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${recipeId}/upload`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        fileName,
        fileType,
        fileSize,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error generando URL de upload');
    }

    const result = await response.json();

    // ✅ CORRECCIÓN: Extraer data de la respuesta del servidor
    if (result.success && result.data) {
      return {
        uploadURL: result.data.uploadURL,
        fileKey: result.data.fileKey,
        fileURL: result.data.fileURL // Puede ser undefined
      };
    }

    throw new Error('Respuesta del servidor inválida');
  },

  async confirmRecipeUpload(
    recipeId: string,
    fileKey: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    fileURL: string
  ): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${recipeId}/upload`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        fileKey,
        fileName,
        fileType,
        fileSize,
        fileURL
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error confirmando upload');
    }
    return response.json();
  },

  async deleteRecipeImage(recipeId: string, fileKey: string): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${recipeId}/upload`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fileKey }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error eliminando imagen');
    }
    return response.json();
  },

  // Método para obtener receta individual
  async getRecipe(id: string): Promise<ApiResponse<Recipe>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${id}`, {
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthToken();
        window.location.href = '/login';
      }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al cargar receta');
    }
    return response.json();
  },

  // Método actualizado para crear receta
  async createRecipe(data: RecipeFormData & { image?: RecipeImage }): Promise<ApiResponse<Recipe>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error creando receta');
    }
    return response.json();
  },

  // Método actualizado para actualizar receta
  async updateRecipe(id: string, data: Partial<RecipeFormData> & { image?: RecipeImage }): Promise<ApiResponse<Recipe>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error actualizando receta');
    }
    return response.json();
  },

  // Método para eliminar receta
  async deleteRecipe(id: string): Promise<ApiResponse<{ success: boolean }>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error eliminando receta');
    }
    return response.json();
  },

  // Método para inicializar base de datos (para desarrollo)
  async initializeRecipesDatabase(): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/recipes`, {
      method: 'PUT',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error inicializando base de datos');
    }
    return response.json();
  },

  // Agregar al objeto apiClient
  analyzeRecipeNutrition: async (
    ingredients: string[],
    servings: number = 1
  ): Promise<{
    success: boolean;
    data: NutritionAnalysisResult;
    source: 'ai' | 'local' | 'manual';
    warning?: string;
    timestamp: string;
  }> => {
    const response = await fetch(`${API_BASE_URL}/api/recipes/analyze-nutrition`, {
      method: 'POST',
      headers: getAuthHeaders(), // Usar la misma función que las demás llamadas
      body: JSON.stringify({
        ingredients,
        servings,
        timestamp: new Date().toISOString()
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw apiError(error, 'Error analizando nutrición');
    }

    return response.json();
  },

  // Buscar recetas
  async searchRecipes(query: string) {
    const response = await fetch(`${API_BASE_URL}/api/recipes?search=${encodeURIComponent(query)}&mode=search`);
    return response.json();
  },

  // Obtener receta por ID
  async getRecipeById(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/recipes/${id}`);
    return response.json();
  },

  // Actualizar campo de sesión (summary/vision)
  async updateAISessionField(clientId: string, sessionId: string, field: string, value: string) {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
    return response.json();
  },

  // Crear nuevo ítem en checklist
  async createAIChecklistItem(clientId: string, sessionId: string, data: CreateChecklistItemData) {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai/sessions/${sessionId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return response.json();
  },

  // Actualizar ítem existente
  async updateAIChecklistItem(clientId: string, sessionId: string, itemId: string, data: UpdateChecklistItemData) {
  // Puedes tipar data según lo que acepte tu backend
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai/sessions/${sessionId}/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return response.json();
  },

  // Eliminar ítem
  async deleteAIChecklistItem(clientId: string, sessionId: string, itemId: string) {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai/sessions/${sessionId}/items/${itemId}`, {
      method: 'DELETE',
    });
    return response.json();
  },
  async updateAISessionFields(
    clientId: string,
    sessionId: string,
    fields: {
      summary?: string;
      vision?: string;
      structuredMedicalAnalysis?: {
        examIndex: number;
        field: 'intro' | 'analysis';
        value: string;
      };
      exerciseIntro?: {
        weekIndex: number;
        value: string;
      };
    }
  ): Promise<ApiResponse<{ session: AIRecommendationSession }>> {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        action: 'update_session_fields',
        sessionId,
        data: { fields }
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error actualizando campos de sesión');
    }
    return response.json();
  },

  async updateAIShoppingList(clientId: string, sessionId: string, weekNumber: number): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        action: 'generate_shopping_list',
        sessionId,
        data: { weekNumber }
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error actualizando lista de compras');
    }
    return response.json();
  },

  async updateWeeklyPlan(
    clientId: string,
    sessionId: string,
    checklistItems: ChecklistItem[],
    weekNumber: number
  ): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientId}/ai`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        action: 'update_weekly_plan',
        sessionId,
        data: { checklistItems, weekNumber }
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error actualizando plan semanal');
    }
    return response.json();
  },

  // ── Exercises ──
  async getExercises(search?: string): Promise<ApiResponse<Exercise[]>> {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    const response = await fetch(`${API_BASE_URL}/api/exercises?${params.toString()}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al cargar ejercicios');
    }
    return response.json();
  },

  async createExercise(data: ExerciseFormData): Promise<ApiResponse<{ id: string }>> {
    const response = await fetch(`${API_BASE_URL}/api/exercises`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al crear ejercicio');
    }
    return response.json();
  },

  async updateExercise(id: string, data: Partial<ExerciseFormData>): Promise<ApiResponse<unknown>> {
    const response = await fetch(`${API_BASE_URL}/api/exercises`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ id, ...data }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al actualizar ejercicio');
    }
    return response.json();
  },

  // generateExerciseUploadURL — COMENTADO: se preserva para futuro uso con GIFs
  // async generateExerciseUploadURL(...): Promise<UploadResponse> { ... },

  // confirmExerciseUpload — COMENTADO: se preserva para futuro uso con GIFs
  // async confirmExerciseUpload(...): Promise<ApiResponse<unknown>> { ... },

  // deleteExerciseImage — COMENTADO: se preserva para futuro uso con GIFs
  // async deleteExerciseImage(...): Promise<ApiResponse<unknown>> { ... },

  async deleteExercises(ids: string[]): Promise<ApiResponse<{ deletedCount: number }>> {
    const response = await fetch(`${API_BASE_URL}/api/exercises`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al eliminar ejercicios');
    }
    return response.json();
  },

  // ─── NUEVOS: Auth multi-usuario ───

  async register(data: { firstName: string; lastName: string; email: string; phone: string; password: string }) {
    const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al registrarse');
    return result;
  },

  async forgotPassword(email: string) {
    const response = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al solicitar recuperación');
    return result;
  },

  async resetPassword(token: string, password: string) {
    const response = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al restablecer contraseña');
    return result;
  },

  async getProfile() {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      if (response.status === 401) { window.location.href = '/login'; return null; }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener perfil');
    }
    return response.json();
  },

  async updateProfile(data: { firstName?: string; lastName?: string; phone?: string; professionalTitle?: string; specialties?: string[]; yearsOfExperience?: number; bio?: string; timezone?: string; profilePhoto?: unknown }) {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al actualizar perfil');
    }
    return response.json();
  },

  async changePassword(currentPassword: string, newPassword: string) {
    const response = await fetch(`${API_BASE_URL}/api/auth/change-password`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al cambiar contraseña');
    return result;
  },

  async getCoachLink(type?: 'paid' | 'free') {
    const params = type ? `?type=${type}` : '';
    const response = await fetch(`${API_BASE_URL}/api/coaches/link${params}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener enlace');
    }
    return response.json();
  },

  async getEditProposals(params?: { targetType?: string; status?: string }) {
    const query = new URLSearchParams();
    if (params?.targetType) query.set('targetType', params.targetType);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    const url = `${API_BASE_URL}/api/edit-proposals${qs ? `?${qs}` : ''}`;
    const response = await fetch(url, { headers: getAuthHeaders() });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener propuestas');
    }
    return response.json();
  },

  async approveProposal(proposalId: string) {
    const response = await fetch(`${API_BASE_URL}/api/edit-proposals/${proposalId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'approve' }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al aprobar propuesta');
    }
    return response.json();
  },

  async rejectProposal(proposalId: string, reviewNotes?: string) {
    const response = await fetch(`${API_BASE_URL}/api/edit-proposals/${proposalId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'reject', reviewNotes }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al rechazar propuesta');
    }
    return response.json();
  },

  async getCoaches() {
    const response = await fetch(`${API_BASE_URL}/api/coaches`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener coaches');
    }
    return response.json();
  },

  async deleteCoach(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/coaches/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al eliminar coach');
    }
    return response.json();
  },

  // ─── Stripe Connect ───

  async createConnectAccount() {
    const response = await fetch(`${API_BASE_URL}/api/payments/create-connect-account`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al conectar con Stripe');
    }
    return response.json();
  },

  async getConnectOnboardingLink() {
    const response = await fetch(`${API_BASE_URL}/api/payments/connect-onboarding-link`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener enlace de configuración');
    }
    return response.json();
  },

  async getConnectAccountStatus() {
    const response = await fetch(`${API_BASE_URL}/api/payments/connect-account-status`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener estado de Stripe');
    }
    return response.json();
  },

  async getFinances(period: '6m' | '12m' | 'all' = '12m') {
    const response = await fetch(`${API_BASE_URL}/api/payments/finances?period=${period}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener datos financieros');
    }
    return response.json();
  },

  async updateSessionPrice(price: number) {
    const response = await fetch(`${API_BASE_URL}/api/payments/session-price`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ price }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al actualizar precio');
    }
    return response.json();
  },

  async uploadCoachPhoto(file: File) {
    const presignedRes = await fetch(`${API_BASE_URL}/api/coaches/upload`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      }),
    });
    if (!presignedRes.ok) throw new Error('Error al obtener URL de subida');
    const presignedData = await presignedRes.json();
    const { uploadURL, fileKey, fileURL } = presignedData.data;

    await fetch(uploadURL, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });

    const confirmRes = await fetch(`${API_BASE_URL}/api/coaches/upload`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fileKey, fileName: file.name, fileType: file.type, fileSize: file.size, fileURL }),
    });
    if (!confirmRes.ok) throw new Error('Error al confirmar foto');
    return confirmRes.json();
  },

  // ── Trial methods ──

  async trialRegister(data: { firstName: string; lastName: string; email: string; phone: string; password: string }) {
    const response = await fetch(`${API_BASE_URL}/api/auth/trial-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al registrarse en prueba gratuita');
    return result;
  },

  async trialCancel() {
    const response = await fetch(`${API_BASE_URL}/api/trial/cancel`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al cancelar cuenta');
    return result;
  },

  async trialConvert() {
    const response = await fetch(`${API_BASE_URL}/api/trial/convert`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al convertir a suscripción paga');
    return result;
  },

  // ─── Gestión de cuenta ───

  async getAccountInfo() {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      if (response.status === 401) { window.location.href = '/login'; return null; }
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener info de cuenta');
    }
    return response.json();
  },

  async verifyPassword(currentPassword: string) {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-password', currentPassword }),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al verificar contraseña');
    return result;
  },

  async suspendAccount() {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'suspend' }),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al suspender cuenta');
    return result;
  },

  async deleteAccount(currentPassword: string) {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', currentPassword }),
    });
    const result = await response.json();
    if (!response.ok) throw apiError(result, 'Error al eliminar cuenta');
    return result;
  },

  // ─── Notificaciones ─────────────────────────────────────

  async getNotifications(page = 1, limit = 20) {
    const response = await fetch(
      `${API_BASE_URL}/api/notifications?page=${page}&limit=${limit}`,
      { headers: getAuthHeaders() }
    );
    if (!response.ok) throw new Error('Error al cargar notificaciones');
    return response.json();
  },

  async getUnreadNotificationCount() {
    const response = await fetch(
      `${API_BASE_URL}/api/notifications/unread-count`,
      { headers: getAuthHeaders() }
    );
    if (!response.ok) throw new Error('Error al obtener conteo de notificaciones');
    return response.json();
  },

  async markNotificationAsRead(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/notifications/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Error al marcar notificación como leída');
    return response.json();
  },

  async markAllNotificationsAsRead() {
    const response = await fetch(`${API_BASE_URL}/api/notifications`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'markAllRead' }),
    });
    if (!response.ok) throw new Error('Error al marcar notificaciones como leídas');
    return response.json();
  },

  // ═══════════════════════════════════════════════
  // ADMIN — Receipt Upload
  // ═══════════════════════════════════════════════

  async generateReceiptUploadURL(expenseId: string, data: { fileName: string; fileType: string; fileSize: number }) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses/${expenseId}/receipt`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al generar URL de upload');
    }
    return response.json();
  },

  async confirmReceiptUpload(expenseId: string, data: { s3Key: string; originalName: string; mimeType: string; size: number }) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses/${expenseId}/receipt`, {
      method: 'PUT',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al confirmar upload de recibo');
    }
    return response.json();
  },

  async deleteReceipt(expenseId: string) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses/${expenseId}/receipt`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al eliminar recibo');
    }
    return response.json();
  },

  // ═══════════════════════════════════════════════
  // ADMIN — Finanzas Corporativas
  // ═══════════════════════════════════════════════

  async getAdminFinanceSummary(period: 'ytd' | 'this_quarter' | 'last_quarter' = 'ytd') {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/summary?period=${period}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener resumen financiero');
    }
    return response.json();
  },

  async getAdminFinanceTransactions(params: {
    type?: 'income' | 'expense';
    taxYear?: number;
    page?: number;
    limit?: number;
    category?: string;
    from?: string;
    to?: string;
  } = {}) {
    const query = new URLSearchParams();
    if (params.type) query.set('type', params.type);
    if (params.taxYear) query.set('taxYear', String(params.taxYear));
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.category) query.set('category', params.category);
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);

    const response = await fetch(`${API_BASE_URL}/api/admin/finances/transactions?${query.toString()}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener transacciones');
    }
    return response.json();
  },

  async getAdminFinanceExpenses(params: {
    category?: string;
    taxYear?: number;
    page?: number;
    limit?: number;
    from?: string;
    to?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {}) {
    const query = new URLSearchParams();
    if (params.category) query.set('category', params.category);
    if (params.taxYear) query.set('taxYear', String(params.taxYear));
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    if (params.sortBy) query.set('sortBy', params.sortBy);
    if (params.sortOrder) query.set('sortOrder', params.sortOrder);

    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses?${query.toString()}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener gastos');
    }
    return response.json();
  },

  async createAdminFinanceExpense(data: {
    amount: number;
    date: string;
    description: string;
    category: string;
    subcategory?: string;
    vendor?: string;
    paymentMethod?: string;
    notes?: string;
    isRecurring?: boolean;
    recurringPeriod?: string;
    isDeductible?: boolean;
    deductionPercentage?: number;
  }) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al crear gasto');
    }
    return response.json();
  },

  async updateAdminFinanceExpense(id: string, data: Record<string, unknown>) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses/${id}`, {
      method: 'PUT',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al actualizar gasto');
    }
    return response.json();
  },

  async deleteAdminFinanceExpense(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/expenses/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al eliminar gasto');
    }
    return response.json();
  },

  async getAdminFinanceSettings() {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/settings`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al obtener configuración fiscal');
    }
    return response.json();
  },

  async updateAdminFinanceSettings(data: Record<string, unknown>) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/settings`, {
      method: 'PUT',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al actualizar configuración fiscal');
    }
    return response.json();
  },

  async downloadFinanceReportPDF(type: 'schedule_c' | 'form_568' | 'quarterly', year: number): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/reports/pdf`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, year }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al descargar PDF');
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}_${year}_NELHEALTHCOACH_LLC.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  async generateAdminFinanceReport(type: 'schedule_c' | 'form_568' | 'quarterly', year: number) {
    const response = await fetch(`${API_BASE_URL}/api/admin/finances/reports`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, year }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw apiError(errorData, 'Error al generar reporte');
    }
    return response.json();
  },

  getAdminFinanceExportURL(params: {
    type?: 'income' | 'expense';
    taxYear?: number;
    format?: 'quickbooks' | 'schedule_c';
  } = {}): string {
    const query = new URLSearchParams();
    if (params.type) query.set('type', params.type);
    if (params.taxYear) query.set('taxYear', String(params.taxYear));
    if (params.format) query.set('format', params.format);
    return `${API_BASE_URL}/api/admin/finances/export?${query.toString()}`;
  },
};
