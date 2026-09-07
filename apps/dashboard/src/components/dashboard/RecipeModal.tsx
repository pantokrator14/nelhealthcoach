import React, { useState, useEffect, useCallback, useRef, ChangeEvent } from 'react';
import { Recipe, RecipeFormData, RecipeImage } from '../../../../../packages/types/src/recipe-types';

import AutocompleteInput from '../ui/AutocompleteInput';
import DragDropList from '../ui/DragDropList';
import { NutritionTooltip } from '../ui/Tooltip';
import { apiClient } from '../../lib/api';
import { translateApiError } from '../../lib/apiErrorText';
import { useToast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';

interface RecipeModalProps {
  recipe: Recipe | null;
  onClose: () => void;
  onSuccess?: (updatedRecipe?: Recipe) => void; // Solo para recargar lista en RecipesPage
  existingCategories?: string[];
  existingTags?: string[];
}

interface NutritionDetails {
  total: {
    protein: number;
    carbs: number;
    fat: number;
    calories: number;
  };
  perServing: {
    protein: number;
    carbs: number;
    fat: number;
    calories: number;
  };
  ingredients: Array<{
    ingredient: string;
    quantity: number;
    unit: string;
    contribution: {
      protein: number;
      carbs: number;
      fat: number;
      calories: number;
      percentage: number;
    };
  }>;
  servings: number;
  ketoRatio?: {
    fatPercentage: number;
    proteinPercentage: number;
    carbPercentage: number;
    isKetoFriendly: boolean;
  };
  source?: 'ai' | 'local' | 'manual';
}

const RecipeModal: React.FC<RecipeModalProps> = ({
  recipe,
  onClose,
  onSuccess,
  existingCategories = [],
  existingTags = [],
}) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<RecipeFormData>({
    title: '',
    description: '',
    category: [],
    ingredients: [],
    instructions: [],
    nutrition: {
      protein: 0,
      carbs: 0,
      fat: 0,
      calories: 0,
    },
    cookTime: 30,
    difficulty: 'medium',
    tags: [],
    servings: 1,
  });
  
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  
  const [newCategory, setNewCategory] = useState('');
  const [newIngredient, setNewIngredient] = useState('');
  const [newInstruction, setNewInstruction] = useState('');
  const [newTag, setNewTag] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  
  // Estados para manejar sugerencias dinámicas
  const [availableCategories, setAvailableCategories] = useState<string[]>(existingCategories);
  const [availableTags, setAvailableTags] = useState<string[]>(existingTags);

  const [isCalculatingNutrition, setIsCalculatingNutrition] = useState(false);
  const [nutritionSource, setNutritionSource] = useState<'manual' | 'ai' | 'local'>('manual');
  const [nutritionDetails, setNutritionDetails] = useState<NutritionDetails | null>(null);
  
  // Estados para edición de ingredientes e instrucciones
  const [editingIngredientIndex, setEditingIngredientIndex] = useState<number | null>(null);
  const [editingIngredientText, setEditingIngredientText] = useState<string>('');
  const [editingInstructionIndex, setEditingInstructionIndex] = useState<number | null>(null);
  const [editingInstructionText, setEditingInstructionText] = useState<string>('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showToast, ToastComponent } = useToast();

  // Inicializar con datos de receta existente
  useEffect(() => {
    if (recipe) {
      setFormData({
        title: recipe.title,
        description: recipe.description,
        category: recipe.category,
        ingredients: recipe.ingredients,
        instructions: recipe.instructions,
        nutrition: recipe.nutrition,
        cookTime: recipe.cookTime,
        difficulty: recipe.difficulty,
        tags: recipe.tags,
      });
      
      if (recipe.image && recipe.image.url) {
        setImagePreview(recipe.image.url);
      }
      
      // Actualizar listas disponibles con las de esta receta
      const allCategories = [...new Set([...existingCategories, ...recipe.category])];
      const allTags = [...new Set([...existingTags, ...recipe.tags])];
      setAvailableCategories(allCategories.sort());
      setAvailableTags(allTags.sort());
    } else {
      // Para nueva receta, usar las existentes
      setAvailableCategories(existingCategories);
      setAvailableTags(existingTags);
    }
  }, [recipe, existingCategories, existingTags]);

  // Cerrar modal con tecla Esc (si no está enviando o subiendo)
  useEffect(() => {
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting && !isUploading) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [onClose, isSubmitting, isUploading]);

  // Cancelar edición con Escape
  useEffect(() => {
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (editingIngredientIndex !== null) {
          setEditingIngredientIndex(null);
          setEditingIngredientText('');
        }
        if (editingInstructionIndex !== null) {
          setEditingInstructionIndex(null);
          setEditingInstructionText('');
        }
      }
    };
    document.addEventListener('keydown', handleGlobalEscape);
    return () => document.removeEventListener('keydown', handleGlobalEscape);
  }, [editingIngredientIndex, editingInstructionIndex]);

  // Función para calcular nutrición automáticamente
  const calculateNutritionAutomatically = async () => {
    if (formData.ingredients.length === 0) {
      showToast(t('recipes.addIngredientsFirst'), 'warning');
      return;
    }
    
    setIsCalculatingNutrition(true);
    try {
      const response = await apiClient.analyzeRecipeNutrition(
        formData.ingredients,
        formData.servings || 1
      );
      
      if (response.success && response.data) {
        // Actualizar datos de nutrición
        setFormData(prev => ({
          ...prev,
          nutrition: response.data.perServing,
        }));
        
        // Guardar detalles para mostrar
        setNutritionDetails({
          ...response.data,
          source: response.source
        });
        
        setNutritionSource(response.source || 'ai');
        
        showToast(
          t('recipes.nutritionCalculated', { source: response.source === 'ai' ? t('recipes.ai') : t('recipes.local') }), 
          'success'
        );
      }
    } catch (error) {
      console.error('Error calculando nutrición:', error);
      showToast(t('recipes.errorCalculatingNutrition'), 'error');
    } finally {
      setIsCalculatingNutrition(false);
    }
  };

  // Función para agregar nueva categoría (y actualizar lista)
  const handleAddCategory = (category: string) => {
    const trimmedCategory = category.trim();
    if (!trimmedCategory) return;
    
    if (!formData.category.includes(trimmedCategory)) {
      setFormData(prev => ({
        ...prev,
        category: [...prev.category, trimmedCategory],
      }));
      
      if (!availableCategories.includes(trimmedCategory)) {
        setAvailableCategories(prev => [...prev, trimmedCategory].sort());
      }
      
      setErrors(prev => ({ ...prev, category: '' }));
    }
  };

  // Función para crear nueva categoría desde AutocompleteInput
  const handleCreateCategory = (category: string) => {
    const categories = category.split(/[, ]+/).map(cat => cat.trim()).filter(cat => cat);
    categories.forEach(cat => handleAddCategory(cat));
    setNewCategory('');
  };

  // Función para eliminar categoría
  const handleRemoveCategory = (index: number) => {
    setFormData(prev => ({
      ...prev,
      category: prev.category.filter((_, i) => i !== index),
    }));
  };

  // Función para agregar nueva etiqueta (y actualizar lista)
  const handleAddTag = (tag: string) => {
    const trimmedTag = tag.trim();
    if (!trimmedTag) return;
    
    if (!formData.tags.includes(trimmedTag)) {
      setFormData(prev => ({
        ...prev,
        tags: [...prev.tags, trimmedTag],
      }));
      
      if (!availableTags.includes(trimmedTag)) {
        setAvailableTags(prev => [...prev, trimmedTag].sort());
      }
    }
  };

  // Función para crear nueva etiqueta desde AutocompleteInput
  const handleCreateTag = (tag: string) => {
    const tags = tag.split(/[, ]+/).map(t => t.trim()).filter(t => t);
    tags.forEach(t => handleAddTag(t));
    setNewTag('');
  };

  // Función para eliminar etiqueta
  const handleRemoveTag = (index: number) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter((_, i) => i !== index),
    }));
  };

  // Manejar selección de archivo
  const handleImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        showToast(t('recipes.invalidImageType'), 'error');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        return;
      }

      const maxSize = 10 * 1024 * 1024;
      if (file.size > maxSize) {
        showToast(t('recipes.imageTooLarge'), 'error');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        return;
      }

      setImageFile(file);
      setErrors(prev => ({ ...prev, image: '' }));
      
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.onerror = () => {
        setImagePreview(null);
        setImageFile(null);
        showToast(t('recipes.errorReadingFile'), 'error');
      };
      reader.readAsDataURL(file);
    }
  };

  // ✅ FUNCIÓN MEJORADA PARA SUBIR IMAGEN A S3 - CORREGIDA
  const uploadImageToS3 = useCallback(async (file: File, recipeId: string): Promise<RecipeImage> => {
    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      // 1. Generar URL de upload
      const uploadResponse = await apiClient.generateRecipeUploadURL(
        recipeId,
        file.name,
        file.type,
        file.size
      );

      // ✅ CORRECCIÓN: Acceder correctamente a los datos de la respuesta
      const { uploadURL, fileKey } = uploadResponse;
      
      // ✅ Obtener fileURL del servidor o construirla si no viene
      const fileURL = uploadResponse.fileURL;
      
      if (!fileURL) {
        // Si el servidor no proporciona fileURL, el endpoint PUT la generará
        console.log('⚠️ fileURL no proporcionado por el servidor, se generará en el backend');
      }

      // 2. Subir archivo a S3
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(progress);
          }
        });

        xhr.addEventListener('load', async () => {
          if (xhr.status === 200) {
            try {
              // 3. Confirmar upload y guardar referencia
              // ✅ CORRECCIÓN: Enviar fileURL aunque pueda estar vacío
              await apiClient.confirmRecipeUpload(
                recipeId,
                fileKey,
                file.name,
                file.type,
                file.size,
                fileURL || ''
              );

              // El backend generará la URL completa si no se proporciona
              const imageData: RecipeImage = {
                url: fileURL || '', // Puede estar vacío, el backend lo manejará
                key: fileKey,
                name: file.name,
                type: file.type,
                size: file.size,
                uploadedAt: new Date().toISOString(),
              };

              resolve(imageData);
            } catch (confirmError) {
              reject(new Error(`Error confirmando upload: ${confirmError instanceof Error ? confirmError.message : 'Error desconocido'}`));
            }
          } else {
            reject(new Error(`Error subiendo archivo a S3: ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => {
          reject(new Error('Error de conexión al subir archivo'));
        });

        xhr.addEventListener('abort', () => {
          reject(new Error('Upload cancelado'));
        });

        xhr.open('PUT', uploadURL);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });
    } catch (error) {
      throw new Error(`Error generando URL de upload: ${error instanceof Error ? error.message : 'Error desconocido'}`);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  }, []);

  // ✅ FUNCIÓN PARA MANEJAR LA SUBIDA DE IMAGEN DURANTE CREACIÓN


  // Validar formulario
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    
if (!formData.title.trim()) newErrors.title = t('recipes.required');
    if (!formData.description.trim()) newErrors.description = t('recipes.required');
    if (formData.category.length === 0) newErrors.category = t('recipes.required');
    if (formData.instructions.length === 0) newErrors.instructions = t('recipes.required');
    if (formData.nutrition.calories < 0) newErrors.calories = t('recipes.error');
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // ✅ MANEJAR ENVÍO DEL FORMULARIO - VERSIÓN SIMPLIFICADA
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    
    try {
      let updatedRecipeData: Recipe | null = null;

      if (recipe?.id) {
        // ✅ CASO EDICIÓN: Receta existente
        let recipeData: RecipeFormData = { ...formData };
        
        if (imageFile) {
          try {
            // Subir nueva imagen
            const imageData = await uploadImageToS3(imageFile, recipe.id);
            recipeData = { ...recipeData, image: imageData };
          } catch (uploadError) {
            console.error('Error subiendo imagen:', uploadError);
            showToast(t('recipes.recipeUpdatedImageError'), 'warning');
          }
        }
        
        // Actualizar receta existente
        const response = await apiClient.updateRecipe(recipe.id, recipeData);
        if (response.success && response.data) {
          updatedRecipeData = response.data;
        } else {
          throw new Error(t('recipes.error'));
        }
        
      } else {
        // ✅ CASO CREACIÓN: Nueva receta
        // 1. Crear receta sin imagen primero (para obtener ID)
        const createResponse = await apiClient.createRecipe({
          ...formData,
          image: undefined
        });
        
        if (!createResponse.success || !createResponse.data?.id) {
          throw new Error('Error creando receta: No se pudo obtener el ID');
        }
        
        const createdRecipeId = createResponse.data.id;
        updatedRecipeData = createResponse.data; // Receta inicial (sin imagen)

        // 2. Subir imagen si existe
        if (imageFile) {
          try {
            const uploadedImage = await uploadImageToS3(imageFile, createdRecipeId);
            
            // 3. Actualizar la receta con la imagen
            const updateResponse = await apiClient.updateRecipe(createdRecipeId, { 
              ...formData, 
              image: uploadedImage 
            });
            
            if (updateResponse.success && updateResponse.data) {
              updatedRecipeData = updateResponse.data; // Receta final con imagen
            } else {
showToast(t('recipes.recipeCreatedImageError'), 'warning');
              // Si falla, mantenemos la receta sin imagen
            }
          } catch (imageError) {
            console.error('Error en proceso de imagen:', imageError);
            showToast(t('recipes.recipeCreatedImageError'), 'warning');
          }
        }
      }
      
      // ✅ Llamar a onSuccess con la receta actualizada
      if (onSuccess) {
        onSuccess(updatedRecipeData || undefined);
      }
      
      showToast(
        t(recipe ? 'recipes.modalSavedSuccess' : 'recipes.modalCreatedSuccess'),
        'success'
      );
      
      // ❌ Eliminado el cierre automático (ahora lo maneja el padre)
      
    } catch (error) {
      console.error('Error guardando receta:', error);
      const errorMessage = translateApiError(error, t, 'recipes.error');
      showToast(errorMessage, 'error');
      setErrors(prev => ({ ...prev, form: errorMessage }));
    } finally {
      setIsSubmitting(false);
    }
  };


  const handleInputChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    
    if (name.startsWith('nutrition.')) {
      const field = name.split('.')[1] as keyof typeof formData.nutrition;
      setFormData(prev => ({
        ...prev,
        nutrition: {
          ...prev.nutrition,
          [field]: parseFloat(value) || 0,
        },
      }));
      setErrors(prev => ({ ...prev, [field]: '' }));
    } else if (name === 'cookTime' || name === 'difficulty') {
      setFormData(prev => ({
        ...prev,
        [name]: name === 'cookTime' ? parseInt(value, 10) || 0 : value,
      }));
      setErrors(prev => ({ ...prev, [name]: '' }));
    } else {
      setFormData(prev => ({
        ...prev,
        [name]: value,
      }));
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const handleAddIngredient = () => {
    if (newIngredient.trim()) {
      setFormData(prev => ({
        ...prev,
        ingredients: [...prev.ingredients, newIngredient.trim()],
      }));
      setNewIngredient('');
      setErrors(prev => ({ ...prev, ingredients: '' }));
    }
  };

  const handleRemoveIngredient = (index: number) => {
    setFormData(prev => ({
      ...prev,
      ingredients: prev.ingredients.filter((_, i) => i !== index),
    }));
  };

  const handleReorderIngredients = (reorderedItems: string[]) => {
    setFormData(prev => ({
      ...prev,
      ingredients: reorderedItems,
    }));
  };

  // Editar ingrediente
  const startEditIngredient = (index: number, text: string) => {
    setEditingIngredientIndex(index);
    setEditingIngredientText(text);
  };

  const saveEditIngredient = () => {
    if (editingIngredientIndex !== null && editingIngredientText.trim()) {
      const updatedIngredients = [...formData.ingredients];
      updatedIngredients[editingIngredientIndex] = editingIngredientText.trim();
      setFormData(prev => ({ ...prev, ingredients: updatedIngredients }));
    }
    setEditingIngredientIndex(null);
    setEditingIngredientText('');
  };

  const cancelEditIngredient = () => {
    setEditingIngredientIndex(null);
    setEditingIngredientText('');
  };

  const handleAddInstruction = () => {
    if (newInstruction.trim()) {
      setFormData(prev => ({
        ...prev,
        instructions: [...prev.instructions, newInstruction.trim()],
      }));
      setNewInstruction('');
      setErrors(prev => ({ ...prev, instructions: '' }));
    }
  };

  const handleRemoveInstruction = (index: number) => {
    setFormData(prev => ({
      ...prev,
      instructions: prev.instructions.filter((_, i) => i !== index),
    }));
  };

  const handleReorderInstructions = (reorderedItems: string[]) => {
    setFormData(prev => ({
      ...prev,
      instructions: reorderedItems,
    }));
  };

  // Editar instrucción
  const startEditInstruction = (index: number, text: string) => {
    setEditingInstructionIndex(index);
    setEditingInstructionText(text);
  };

  const saveEditInstruction = () => {
    if (editingInstructionIndex !== null && editingInstructionText.trim()) {
      const updatedInstructions = [...formData.instructions];
      updatedInstructions[editingInstructionIndex] = editingInstructionText.trim();
      setFormData(prev => ({ ...prev, instructions: updatedInstructions }));
    }
    setEditingInstructionIndex(null);
    setEditingInstructionText('');
  };

  const cancelEditInstruction = () => {
    setEditingInstructionIndex(null);
    setEditingInstructionText('');
  };

  // Manejar tecla Enter en inputs y textareas
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>, callback: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      callback();
    }
  };

  // Obtener sugerencias únicas de categorías y tags
  const getUniqueSuggestions = (items: string[], existingItems: string[]) => {
    const allItems = [...new Set([...items, ...existingItems])];
    return allItems.filter(item => item.trim() !== '');
  };

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-4 z-50 overflow-y-auto">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl my-4 sm:my-8 max-h-[95vh] flex flex-col mx-2 sm:mx-4">
          {/* Header */}
          <div className="flex justify-between items-center p-4 sm:p-6 border-b bg-gradient-to-r from-green-600 to-green-700 text-white rounded-t-xl">
            <h2 className="text-xl sm:text-2xl font-bold">
              {t(recipe ? 'recipes.modalEditTitle' : 'recipes.modalNewTitle')}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 sm:p-2 hover:bg-green-800 rounded-full transition"
              aria-label={t('recipes.closeAriaLabel')}
              disabled={isSubmitting || isUploading}
            >
              <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Formulario */}
          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6">
            {/* Mensaje de error general */}
            {errors.form && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 sm:p-4 mb-4 sm:mb-6">
                <div className="flex items-center">
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 text-red-500 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm sm:text-base text-red-700">{errors.form}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 md:gap-8">
              {/* Columna izquierda */}
              <div className="space-y-4 sm:space-y-6">
                {/* Información básica */}
                <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6 shadow-sm">
                  <h3 className="text-base sm:text-lg font-semibold text-blue-700 mb-3 sm:mb-4">{t('recipes.modalBasicInfo')}</h3>
                  
                  <div className="space-y-3 sm:space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t('recipes.titleField')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        name="title"
                        value={formData.title}
                        onChange={handleInputChange}
                        required
                        className={`w-full px-3 sm:px-4 py-2.5 sm:py-3 border text-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 ${
                          errors.title ? 'border-red-300' : 'border-gray-300'
                        }`}
                        placeholder={t('recipes.modalTitlePlaceholder')}
                        disabled={isSubmitting || isUploading}
                      />
                      {errors.title && (
                        <p className="mt-1 text-sm text-red-600">{errors.title}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t('recipes.descriptionField')} <span className="text-red-500">*</span>
                      </label>
                      <textarea
                        name="description"
                        value={formData.description}
                        onChange={handleInputChange}
                        required
                        rows={3}
                        className={`w-full px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 ${
                          errors.description ? 'border-red-300' : 'border-gray-300'
                        }`}
                        placeholder={t('recipes.modalDescriptionPlaceholder')}
                        disabled={isSubmitting || isUploading}
                      />
                      {errors.description && (
                        <p className="mt-1 text-sm text-red-600">{errors.description}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('recipes.modalCookTimeLabel')} <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="number"
                          name="cookTime"
                          value={formData.cookTime}
                          onChange={handleInputChange}
                          min="1"
                          max="999"
                          required
                          className={`w-full px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 ${
                            errors.cookTime ? 'border-red-300' : 'border-gray-300'
                          }`}
                          disabled={isSubmitting || isUploading}
                        />
                        {errors.cookTime && (
                          <p className="mt-1 text-sm text-red-600">{errors.cookTime}</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('recipes.difficultyField')} <span className="text-red-500">*</span>
                        </label>
                        <select
                          name="difficulty"
                          value={formData.difficulty}
                          onChange={handleInputChange}
                          className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border text-gray-700 border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                          disabled={isSubmitting || isUploading}
                          required
                        >
                          <option value="easy">{t('recipes.easy')}</option>
                          <option value="medium">{t('recipes.medium')}</option>
                          <option value="hard">{t('recipes.hard')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Información nutricional */}
                <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4 gap-3">
                    <h3 className="text-base sm:text-lg font-semibold text-green-700 flex items-center">
                      <div className="w-7 h-7 sm:w-8 sm:h-8 bg-green-100 rounded-lg flex items-center justify-center mr-2 sm:mr-3">
                        <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                      </div>
                      {t('recipes.modalNutritionInfo')}
                    </h3>
                    
                    <button
                      type="button"
                      onClick={calculateNutritionAutomatically}
                      disabled={isCalculatingNutrition || formData.ingredients.length === 0 || isSubmitting || isUploading}
                      className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-lg hover:from-green-700 hover:to-emerald-700 transition disabled:opacity-50 text-xs sm:text-sm font-medium shadow-sm whitespace-nowrap flex-shrink-0"
                    >
                      {isCalculatingNutrition ? (
                        <>
                          <div className="animate-spin rounded-full h-3 w-3 sm:h-4 sm:w-4 border-b-2 border-white"></div>
                          {t('recipes.modalCalculating')}
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {/* Ícono de calculadora mejorado */}
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                          </svg>
                          <span className="hidden xs:inline">{t('recipes.modalCalculateNutrition')}</span>
                          <span className="xs:hidden">{t('recipes.modalCalculateShort')}</span>
                        </>
                      )}
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center">
                        {t('recipes.modalProteinLabel')} <NutritionTooltip term="protein" />
                      </label>
                       <input
                         type="number"
                         name="nutrition.protein"
                         value={formData.nutrition.protein}
                         onChange={handleInputChange}
                         min="0"
                         max="1000"
                         step="any"
                         className="w-full px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border border-green-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50"
                         disabled={isSubmitting || isUploading}
                       />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center">
                        {t('recipes.modalCarbsLabel')} <NutritionTooltip term="carbs" />
                      </label>
                       <input
                         type="number"
                         name="nutrition.carbs"
                         value={formData.nutrition.carbs}
                         onChange={handleInputChange}
                         min="0"
                         max="1000"
                         step="any"
                         className="w-full px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border border-green-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50"
                         disabled={isSubmitting || isUploading}
                       />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center">
                        {t('recipes.modalFatLabel')} <NutritionTooltip term="fat" />
                      </label>
                       <input
                         type="number"
                         name="nutrition.fat"
                         value={formData.nutrition.fat}
                         onChange={handleInputChange}
                         min="0"
                         max="1000"
                         step="any"
                         className="w-full px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border border-green-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50"
                         disabled={isSubmitting || isUploading}
                       />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center">
                        {t('recipes.modalCaloriesLabel')} <NutritionTooltip term="calories" />
                      </label>
                        <input
                         type="number"
                         name="nutrition.calories"
                         value={formData.nutrition.calories}
                         onChange={handleInputChange}
                         min="0"
                         max="10000"
                         step="any"
                         className={`w-full px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50 ${
                           errors.calories ? 'border-red-300' : 'border-green-300'
                         }`}
                         disabled={isSubmitting || isUploading}
                       />
                      {errors.calories && (
                        <p className="mt-1 text-sm text-red-600">{errors.calories}</p>
                      )}
                    </div>
                  </div>

                  {nutritionSource !== 'manual' && nutritionDetails && (
                    <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span className="text-sm font-medium text-blue-800">
                            {t('recipes.modalCalculatedAuto')}
                          </span>
                        </div>
                      </div>
                      
                      {nutritionDetails.ketoRatio && (
                        <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
                          <span className="text-xs text-gray-600">
                            {t('recipes.modalKetoPercentages')}
                            {t('recipes.modalKetoFat')} {nutritionDetails.ketoRatio.fatPercentage}% • 
                            {t('recipes.modalKetoProtein')} {nutritionDetails.ketoRatio.proteinPercentage}% • 
                            {t('recipes.modalKetoCarbs')} {nutritionDetails.ketoRatio.carbPercentage}%
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Imagen */}
                <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6 shadow-sm">
                  <h3 className="text-base sm:text-lg font-semibold text-blue-700 mb-3 sm:mb-4">{t('recipes.modalImageLabel')}</h3>
                  
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 sm:p-6 text-center hover:border-blue-500 transition bg-gray-50">
                    {imagePreview ? (
                      <div className="relative">
                        <div 
                          className="w-full h-32 sm:h-48 bg-cover bg-center rounded-lg border border-gray-200 mb-4"
                          style={{ backgroundImage: `url(${imagePreview})` }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setImagePreview(null);
                            setImageFile(null);
                            if (fileInputRef.current) {
                              fileInputRef.current.value = '';
                            }
                          }}
                          className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 bg-red-500 text-white p-1 sm:p-1.5 rounded-full hover:bg-red-600 shadow-sm"
                          disabled={isUploading}
                        >
                          <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <div className="py-4 sm:py-8">
                        <div className="w-12 h-12 sm:w-16 sm:h-16 mx-auto bg-blue-100 rounded-full flex items-center justify-center mb-3 sm:mb-4">
                          <svg className="w-6 h-6 sm:w-8 sm:h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                        <p className="text-gray-700 font-medium mb-2 text-sm sm:text-base">
                          {t('recipes.modalUploadLabel')}
                        </p>
                        <p className="text-xs sm:text-sm text-gray-500 mb-4">
                          {t('recipes.modalUploadHint')}
                        </p>
                      </div>
                    )}
                    
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageChange}
                      className="hidden"
                      id="image-upload"
                      disabled={isUploading}
                    />
                    <label
                      htmlFor="image-upload"
                      className="inline-block px-4 py-2 sm:px-5 sm:py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-sm text-sm sm:text-base"
                    >
                      {imagePreview ? t('recipes.modalChangeImage') : t('recipes.modalSelectImage')}
                    </label>
                  </div>
                  
                  {isUploading && (
                    <div className="mt-4">
                      <div className="flex justify-between text-sm text-gray-700 mb-1">
                        <span className="font-medium">{t('recipes.modalUploadingImage')}</span>
                        <span className="font-bold">{uploadProgress}%</span>
                      </div>
                      <div className="w-full bg-blue-200 rounded-full h-2">
                        <div 
                          className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Columna derecha */}
              <div className="space-y-4 sm:space-y-6">
                {/* Categorías con autocompletado */}
                <div className="bg-white rounded-lg border border-indigo-200 p-4 sm:p-6 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
                    <label className="block text-base sm:text-lg font-semibold text-indigo-700 flex items-center">
                      <div className="w-7 h-7 sm:w-8 sm:h-8 bg-indigo-100 rounded-lg flex items-center justify-center mr-2 sm:mr-3">
                        <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      {t('recipes.modalCategoriesLabel')} <span className="text-red-500">*</span>
                    </label>
                    <span className="text-xs sm:text-sm text-gray-500 bg-gray-100 px-2 sm:px-3 py-1 rounded-full">
                      {t('recipes.modalCategoriesCount', { count: formData.category.length })}
                    </span>
                  </div>
                  
                  {errors.category && (
                    <p className="mb-3 text-sm text-red-600 bg-red-50 p-2 sm:p-3 rounded-lg">{errors.category}</p>
                  )}
                  
                  <div className="mb-4">
                    {/* ✅ AGREGADO: allowCreate y onItemCreate */}
                    <AutocompleteInput
                      suggestions={getUniqueSuggestions(formData.category, availableCategories)}
                      value={newCategory}
                      onChange={setNewCategory}
                      onSelect={handleAddCategory}
                      onItemCreate={handleCreateCategory}
                      allowCreate={true}
                      separator="both"
                      placeholder={t('recipes.modalCategoryPlaceholder')}
                      disabled={isSubmitting || isUploading}
                      maxSuggestions={5}
                      className="border-indigo-300"
                    />
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    {formData.category.map((cat, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-indigo-100 text-indigo-800 rounded-full border border-indigo-200 text-sm"
                      >
                        <span>{cat}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveCategory(index)}
                          className="text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                          disabled={isSubmitting || isUploading}
                        >
                          <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Ingredientes con drag & drop */}
                <div className="bg-white rounded-lg border border-orange-200 p-4 sm:p-6 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
                    <label className="block text-base sm:text-lg font-semibold text-orange-700 flex items-center">
                      <div className="w-7 h-7 sm:w-8 sm:h-8 bg-orange-100 rounded-lg flex items-center justify-center mr-2 sm:mr-3">
                        <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                      </div>
                      {t('recipes.modalIngredientsLabel')} <span className="text-red-500">*</span>
                    </label>
                    <span className="text-xs sm:text-sm text-gray-500 bg-gray-100 px-2 sm:px-3 py-1 rounded-full">
                      {t('recipes.modalIngredientsCount', { count: formData.ingredients.length })}
                    </span>
                  </div>
                  {errors.ingredients && (
                    <p className="mb-3 text-sm text-red-600 bg-red-50 p-2 sm:p-3 rounded-lg">{errors.ingredients}</p>
                  )}
                  
                  <div className="flex flex-col sm:flex-row gap-2 mb-4">
                    <input
                      type="text"
                      value={newIngredient}
                      onChange={(e) => setNewIngredient(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleAddIngredient)}
                      className="w-full sm:flex-1 px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border border-orange-200 rounded-lg disabled:opacity-50 bg-white text-sm sm:text-base"
                      placeholder={t('recipes.modalIngredientPlaceholder')}
                      disabled={isSubmitting || isUploading}
                    />
                    <button
                      type="button"
                      onClick={handleAddIngredient}
                      className="w-full sm:w-auto px-4 py-2.5 sm:px-5 sm:py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition disabled:opacity-50 shadow-sm text-sm sm:text-base"
                      disabled={isSubmitting || isUploading}
                    >
                      {t('recipes.modalAddButton')}
                    </button>
                  </div>
                  
                  {formData.ingredients.length > 0 && (
                    <div className="mb-2 text-xs text-gray-500 flex items-center">
                      <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                      </svg>
                      {t('recipes.modalDragReorderIngredients')}
                    </div>
                  )}
                  
                  <DragDropList
                    items={formData.ingredients}
                    renderItem={(ingredient, index) => {
                      const isEditing = editingIngredientIndex === index;
                      return (
                        <div className="flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 bg-orange-50 rounded-lg border border-orange-200">
                          <div className="w-5 h-5 sm:w-6 sm:h-6 bg-orange-100 text-orange-700 rounded-full flex items-center justify-center text-xs sm:text-sm font-bold">
                            {index + 1}
                          </div>
                          {isEditing ? (
                            <>
                              <input
                                type="text"
                                value={editingIngredientText}
                                onChange={(e) => setEditingIngredientText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEditIngredient();
                                }}
                                className="flex-1 w-full px-2 py-1 border border-orange-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 text-sm sm:text-base"
                                autoFocus
                                disabled={isSubmitting || isUploading}
                              />
                              <div className="flex gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={saveEditIngredient}
                                  className="text-green-500 hover:text-green-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.saveAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditIngredient}
                                  className="text-red-500 hover:text-red-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.cancelEditAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <span className="flex-1 text-gray-700 text-sm sm:text-base">{ingredient}</span>
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => startEditIngredient(index, ingredient)}
                                  className="text-yellow-500 hover:text-yellow-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.editAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveIngredient(index)}
                                  className="text-red-500 hover:text-red-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.deleteAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    }}
                    onReorder={handleReorderIngredients}
                    disabled={isSubmitting || isUploading}
                    className="max-h-48 sm:max-h-64 overflow-y-auto"
                  />
                </div>

                {/* Instrucciones con drag & drop */}
                <div className="bg-white rounded-lg border border-purple-200 p-4 sm:p-6 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
                    <label className="block text-base sm:text-lg font-semibold text-purple-700 flex items-center">
                      <div className="w-7 h-7 sm:w-8 sm:h-8 bg-purple-100 rounded-lg flex items-center justify-center mr-2 sm:mr-3">
                        <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                      </div>
                      {t('recipes.modalInstructionsLabel')} <span className="text-red-500">*</span>
                    </label>
                    <span className="text-xs sm:text-sm text-gray-500 bg-gray-100 px-2 sm:px-3 py-1 rounded-full">
                      {t('recipes.modalInstructionsCount', { count: formData.instructions.length })}
                    </span>
                  </div>
                  
                  {errors.instructions && (
                    <p className="mb-3 text-sm text-red-600 bg-red-50 p-2 sm:p-3 rounded-lg">{errors.instructions}</p>
                  )}
                  
                  <div className="flex flex-col sm:flex-row gap-2 mb-4">
                    <textarea
                      value={newInstruction}
                      onChange={(e) => setNewInstruction(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleAddInstruction)}
                      className="w-full sm:flex-1 px-3 sm:px-4 py-2.5 sm:py-3 text-gray-700 border border-purple-200 rounded-lg disabled:opacity-50 bg-white text-sm sm:text-base"
                      placeholder={t('recipes.modalInstructionPlaceholder')}
                      rows={2}
                      disabled={isSubmitting || isUploading}
                    />
                    <button
                      type="button"
                      onClick={handleAddInstruction}
                      className="w-full sm:w-auto px-4 py-2.5 sm:px-5 sm:py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50 shadow-sm text-sm sm:text-base"
                      disabled={isSubmitting || isUploading}
                    >
                      {t('recipes.modalAddButton')}
                    </button>
                  </div>
                  
                  {formData.instructions.length > 0 && (
                    <div className="mb-2 text-xs text-gray-500 flex items-center">
                      <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                      </svg>
                      {t('recipes.modalDragReorderInstructions')}
                    </div>
                  )}
                  
                  <DragDropList
                    items={formData.instructions}
                    renderItem={(instruction, index) => {
                      const isEditing = editingInstructionIndex === index;
                      return (
                        <div className="flex gap-2 sm:gap-4 p-3 sm:p-4 bg-purple-50 rounded-lg border border-purple-200">
                          <div className="flex-shrink-0">
                            <div className="w-6 h-6 sm:w-8 sm:h-8 flex items-center justify-center bg-purple-100 text-purple-800 rounded-full font-bold border-2 border-purple-300 text-xs sm:text-base">
                              {index + 1}
                            </div>
                          </div>
                          {isEditing ? (
                            <>
                              <div className="flex-1 w-full">
                                <textarea
                                  value={editingInstructionText}
                                  onChange={(e) => setEditingInstructionText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                      e.preventDefault();
                                      saveEditInstruction();
                                    }
                                  }}
                                  className="w-full px-2 py-1 border border-purple-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-sm sm:text-base"
                                  rows={2}
                                  autoFocus
                                  disabled={isSubmitting || isUploading}
                                />
                              </div>
                              <div className="flex gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={saveEditInstruction}
                                  className="text-green-500 hover:text-green-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.saveAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditInstruction}
                                  className="text-red-500 hover:text-red-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.cancelEditAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="flex-1">
                                <p className="text-gray-700 text-sm sm:text-base">{instruction}</p>
                              </div>
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => startEditInstruction(index, instruction)}
                                  className="text-yellow-500 hover:text-yellow-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.editAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveInstruction(index)}
                                  className="text-red-500 hover:text-red-700 disabled:opacity-50 p-1"
                                  disabled={isSubmitting || isUploading}
                                  aria-label={t('recipes.deleteAriaLabel')}
                                >
                                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    }}
                    onReorder={handleReorderInstructions}
                    disabled={isSubmitting || isUploading}
                    className="max-h-48 sm:max-h-64 overflow-y-auto"
                  />
                </div>

                {/* Tags con autocompletado */}
                <div className="bg-white rounded-lg border border-pink-200 p-4 sm:p-6 shadow-sm">
                  <label className="block text-base sm:text-lg font-semibold text-pink-700 mb-3 sm:mb-4 flex items-center">
                    <div className="w-7 h-7 sm:w-8 sm:h-8 bg-pink-100 rounded-lg flex items-center justify-center mr-2 sm:mr-3">
                      <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-pink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                      </svg>
                    </div>
                    {t('recipes.modalTagsLabel')}
                  </label>
                  
                  <div className="mb-4">
                    {/* ✅ AGREGADO: allowCreate y onItemCreate */}
                    <AutocompleteInput
                      suggestions={getUniqueSuggestions(formData.tags, availableTags)}
                      value={newTag}
                      onChange={setNewTag}
                      onSelect={handleAddTag}
                      onItemCreate={handleCreateTag}
                      allowCreate={true}
                      separator="both"
                      placeholder={t('recipes.modalTagPlaceholder')}
                      disabled={isSubmitting || isUploading}
                      maxSuggestions={5}
                      className="border-pink-300"
                    />
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    {formData.tags.map((tag, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-pink-100 text-pink-800 rounded-full border border-pink-200 text-sm"
                      >
                        <span>#{tag}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(index)}
                          className="text-pink-600 hover:text-pink-800 disabled:opacity-50"
                          disabled={isSubmitting || isUploading}
                        >
                          <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Botones */}
            <div className="flex flex-col sm:flex-row justify-end gap-3 pt-6 mt-6 border-t">
              <button
                type="button"
                onClick={onClose}
                className="w-full sm:w-auto px-4 py-2.5 sm:px-6 sm:py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-sm text-sm sm:text-base"
                disabled={isSubmitting || isUploading}
              >
                {t('recipes.modalCancelButton')}
              </button>
              <button
                type="submit"
                className="w-full sm:w-auto px-4 py-2.5 sm:px-6 sm:py-3 bg-gradient-to-r from-green-600 to-green-700 text-white rounded-lg hover:from-green-700 hover:to-green-800 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-sm text-sm sm:text-base"
                disabled={isSubmitting || isUploading}
              >
                {isSubmitting || isUploading ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 sm:h-5 sm:w-5 border-b-2 border-white"></div>
                    {isUploading ? t('recipes.modalUploadingImage') : t('recipes.modalSaving')}
                  </span>
                ) : recipe ? (
                  t('recipes.modalUpdateRecipe')
                ) : (
                  t('recipes.modalCreateRecipe')
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
      <ToastComponent />
    </>
  );
};

export default RecipeModal;