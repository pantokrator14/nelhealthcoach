import { NextRequest, NextResponse } from 'next/server';
import { getRecipesCollection, connectMongoose } from '@/app/lib/database';
import { logger } from '@/app/lib/logger';
import { MongoClient, ObjectId } from 'mongodb';
import { encrypt, decrypt, encryptFileObject, decryptFileObject, safeDecrypt } from '@/app/lib/encryption';
import { requireCoachAuth } from '@/app/lib/auth';
import { recipeSchema } from '@/app/lib/schemas';
import EditProposal from '@/app/models/EditProposal';
import { apiHandler } from '@/app/lib/apiHandler';
import { logAuditEvent } from '@/app/lib/auditLogger';

// GET: Obtener recetas
async function getHandler(request: NextRequest) {
  return logger.time('RECIPES', 'Obtener recetas', async () => {
    try {
      const searchParams = request.nextUrl.searchParams;
      const query = searchParams.get('search') || '';
      const mode = searchParams.get('mode') || 'full'; // 'search' o 'full'
      const limitParam = searchParams.get('limit');

      // Determinar si el usuario es admin (para mostrar no publicados)
      let isAdmin = false;
      try {
        const auth = requireCoachAuth(request);
        isAdmin = auth.role === 'admin';
      } catch {
        // No autenticado: solo ver publicados
      }
      
      const collection = await getRecipesCollection();

      // 1. Obtener recetas (solo publicadas para no-admin)
      const filter: Record<string, unknown> = {};
      if (!isAdmin) {
        filter.isPublished = true;
      }
      const recipes = await collection.find(filter).toArray();

      // 2. Desencriptar todas las recetas
      const decryptedRecipes = recipes.map(recipe => ({
        id: recipe._id.toString(),
        title: safeDecrypt(recipe.title),
        description: safeDecrypt(recipe.description),
        category: recipe.category.map((cat: string) => safeDecrypt(cat)),
        image: recipe.image ? decryptFileObject(recipe.image) : null,
        cookTime: recipe.cookTime,
        difficulty: safeDecrypt(recipe.difficulty),
        nutrition: recipe.nutrition,
        ingredients: recipe.ingredients.map((ing: string) => safeDecrypt(ing)),
        instructions: recipe.instructions.map((inst: string) => safeDecrypt(inst)),
        tags: recipe.tags.map((tag: string) => safeDecrypt(tag)),
        author: safeDecrypt(recipe.author),
        isPublished: recipe.isPublished,
        createdAt: recipe.createdAt,
        updatedAt: recipe.updatedAt,
      }));

      let results = decryptedRecipes;

      // 3. Filtrar por búsqueda si hay query
      if (query) {
        const searchLower = query.toLowerCase();
        results = decryptedRecipes.filter(recipe => 
          recipe.title.toLowerCase().includes(searchLower) ||
          recipe.description.toLowerCase().includes(searchLower) ||
          recipe.ingredients.some((ing: string) => ing.toLowerCase().includes(searchLower)) ||
          recipe.category.some((cat: string) => cat.toLowerCase().includes(searchLower)) ||
          recipe.tags.some((tag: string) => tag.toLowerCase().includes(searchLower)) ||
          (recipe.author && recipe.author.toLowerCase().includes(searchLower))
        );

        // Aplicar límite SOLO si hay búsqueda y se especificó (por defecto 100)
        const limit = limitParam ? parseInt(limitParam) : 100;
        results = results.slice(0, limit);
      }

      // 4. Si mode es 'search', devolver solo campos básicos (incluso si no hay búsqueda, pero normalmente se usa con búsqueda)
      if (mode === 'search') {
        const searchResults = results.map(recipe => ({
          id: recipe.id,
          title: recipe.title,
          description: recipe.description,
          image: recipe.image,
          cookTime: recipe.cookTime,
        }));
        return NextResponse.json({ success: true, data: searchResults });
      }

      // Modo 'full': devolver todos los campos (sin límite cuando no hay búsqueda)
      return NextResponse.json({ success: true, data: results });

    } catch (error: unknown) {
      logger.error('RECIPES', 'Error en búsqueda', error);
      return NextResponse.json(
        { 
          success: false, 
          message: 'Error en búsqueda',
          ...(process.env.NODE_ENV === 'development' && error instanceof Error && { detail: error.message }), code: 'INTERNAL'},
        { status: 500 }
      );
    }
  });
}

export const GET = apiHandler(getHandler);

async function postHandler(request: NextRequest) {
  return logger.time('RECIPES', 'Crear nueva receta', async () => {
    try {
      const data = await request.json();

      // Request context para audit logs
      const reqCtx = {
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        requestId: request.headers.get('x-request-id') || undefined,
      };

      // Zod validation
      const parsed = recipeSchema.safeParse(data);
      if (!parsed.success) {
        const firstError = parsed.error.issues[0];
        return NextResponse.json(
          {
            success: false,
            message: firstError?.message ?? 'Datos de receta inválidos',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
            code: 'VALIDATION',
          },
          { status: 400 },
        );
      }

      const recipesCollection = await getRecipesCollection();

      // Obtener info del coach para el campo author (autenticación requerida)
      const auth = requireCoachAuth(request);
      const authorName = auth.email || 'NelHealthCoach';
      const isAdmin = auth.role === 'admin';

      // Si no es admin, la creación necesita aprobación
      const isPublished = isAdmin ? (data.isPublished !== undefined ? data.isPublished : true) : false;

      // ✅ ENCRIPTAR DIRECTAMENTE CADA CAMPO (sin funciones wrapper)
      const encryptedRecipeData: Record<string, unknown> = {
        title: encrypt(data.title),
        description: encrypt(data.description),
        category: Array.isArray(data.category)
          ? data.category.map((cat: string) => encrypt(cat))
          : [],
        ingredients: Array.isArray(data.ingredients)
          ? data.ingredients.map((ing: string) => encrypt(ing))
          : [],
        instructions: Array.isArray(data.instructions)
          ? data.instructions.map((inst: string) => encrypt(inst))
          : [],
        nutrition: data.nutrition || { protein: 0, carbs: 0, fat: 0, calories: 0 },
        cookTime: data.cookTime || 0,
        difficulty: encrypt(data.difficulty || 'easy'),
        author: data.author ? encrypt(data.author) : encrypt(authorName),
        isPublished,
        tags: Array.isArray(data.tags)
          ? data.tags.map((tag: string) => encrypt(tag))
          : [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // ✅ ENCRIPTAR IMAGEN SI EXISTE
      if (data.image && typeof data.image === 'object') {
        encryptedRecipeData.image = encryptFileObject(data.image);
      } else {
        encryptedRecipeData.image = {
          url: '',
          key: '',
          name: '',
          type: '',
          size: 0,
          uploadedAt: new Date().toISOString()
        };
      }
      
      const result = await recipesCollection.insertOne(encryptedRecipeData);

      // Si no es admin, crear propuesta de creación para moderación
      if (!isAdmin) {
        await connectMongoose();
        await EditProposal.create({
          targetType: 'recipe',
          targetId: new ObjectId(result.insertedId.toString()),
          proposalType: 'creation',
          proposedChanges: {},
          proposedBy: new ObjectId(auth.coachId),
          proposedByName: auth.email,
          status: 'pending',
        });

        logger.info('RECIPES', 'Receta creada pendiente de aprobación', {
          recipeId: result.insertedId.toString(),
          coachId: auth.coachId,
        });

        // Devolver la receta (con indicador de pendiente)
        const insertedRecipe = await recipesCollection.findOne({ _id: result.insertedId });

        if (!insertedRecipe) {
          throw new Error('No se pudo recuperar la receta recién creada');
        }

        const decryptedRecipe: Record<string, unknown> = {
          ...insertedRecipe,
          id: insertedRecipe._id.toString(),
          title: safeDecrypt(insertedRecipe.title),
          description: safeDecrypt(insertedRecipe.description),
          category: Array.isArray(insertedRecipe.category) 
            ? insertedRecipe.category.map((cat: string) => safeDecrypt(cat))
            : [],
          ingredients: Array.isArray(insertedRecipe.ingredients)
            ? insertedRecipe.ingredients.map((ing: string) => safeDecrypt(ing))
            : [],
          instructions: Array.isArray(insertedRecipe.instructions)
            ? insertedRecipe.instructions.map((inst: string) => safeDecrypt(inst))
            : [],
          nutrition: insertedRecipe.nutrition,
          cookTime: insertedRecipe.cookTime,
          difficulty: safeDecrypt(insertedRecipe.difficulty),
          author: insertedRecipe.author ? safeDecrypt(insertedRecipe.author) : 'NelHealthCoach',
          isPublished: insertedRecipe.isPublished,
          tags: Array.isArray(insertedRecipe.tags)
            ? insertedRecipe.tags.map((tag: string) => safeDecrypt(tag))
            : [],
          createdAt: insertedRecipe.createdAt,
          updatedAt: insertedRecipe.updatedAt,
        };

        if (insertedRecipe.image) {
          decryptedRecipe.image = decryptFileObject(insertedRecipe.image);
        } else {
          decryptedRecipe.image = null;
        }

        logAuditEvent({
          eventType: 'RECIPE_CREATED',
          severity: 'info',
          message: `Receta creada: ${data.title}`,
          coachId: auth.coachId,
          ...reqCtx,
          path: '/api/recipes',
          method: 'POST',
          statusCode: 201,
        });

        return NextResponse.json({
          success: true,
          message: 'Tu receta ha sido enviada para revisión del administrador',
          data: { ...decryptedRecipe, pendingApproval: true },
        }, { status: 201 });
      }
      
      logger.info('RECIPES', 'Receta creada exitosamente', {
        insertedId: result.insertedId.toString()
      });
      
      const insertedRecipe = await recipesCollection.findOne({ _id: result.insertedId });
      
      if (!insertedRecipe) {
        throw new Error('No se pudo recuperar la receta recién creada');
      }
      
      // ✅ DESENCRIPTAR PARA RESPONSE
      const decryptedRecipe: Record<string, unknown> = {
        ...insertedRecipe,
        id: insertedRecipe._id.toString(),
        title: safeDecrypt(insertedRecipe.title),
        description: safeDecrypt(insertedRecipe.description),
        category: Array.isArray(insertedRecipe.category) 
          ? insertedRecipe.category.map((cat: string) => safeDecrypt(cat))
          : [],
        ingredients: Array.isArray(insertedRecipe.ingredients)
          ? insertedRecipe.ingredients.map((ing: string) => safeDecrypt(ing))
          : [],
        instructions: Array.isArray(insertedRecipe.instructions)
          ? insertedRecipe.instructions.map((inst: string) => safeDecrypt(inst))
          : [],
        nutrition: insertedRecipe.nutrition,
        cookTime: insertedRecipe.cookTime,
        difficulty: safeDecrypt(insertedRecipe.difficulty),
        author: insertedRecipe.author ? safeDecrypt(insertedRecipe.author) : 'NelHealthCoach',
        isPublished: insertedRecipe.isPublished,
        tags: Array.isArray(insertedRecipe.tags)
          ? insertedRecipe.tags.map((tag: string) => safeDecrypt(tag))
          : [],
        createdAt: insertedRecipe.createdAt,
        updatedAt: insertedRecipe.updatedAt,
      };

      // ✅ DESENCRIPTAR IMAGEN SI EXISTE
      if (insertedRecipe.image) {
        decryptedRecipe.image = decryptFileObject(insertedRecipe.image);
      } else {
        decryptedRecipe.image = null;
      }

      logAuditEvent({
        eventType: 'RECIPE_CREATED',
        severity: 'info',
        message: `Receta creada: ${data.title}`,
        coachId: auth.coachId,
        ...reqCtx,
        path: '/api/recipes',
        method: 'POST',
        statusCode: 201,
      });
      
      return NextResponse.json({
        success: true,
        message: 'Receta creada exitosamente',
        data: decryptedRecipe,
      }, { status: 201 });
      
    } catch (error: unknown) {
      const apiError = error as { status?: number; message?: string };
      // Si es un error estructurado (auth), devolver su status específico
      if (apiError?.status) {
        return NextResponse.json(
          { success: false, message: apiError.message || 'Error' },
          { status: apiError.status }
        );
      }
      logger.error('RECIPES', 'Error creando receta', error);
      return NextResponse.json(
        { success: false, message: 'Error creando receta', code: 'INTERNAL'},
        { status: 500 }
      );
    }
  }, { endpoint: '/api/recipes', method: 'POST' });
}

export const POST = apiHandler(postHandler);

// OPTIONS: Para CORS
export async function OPTIONS(request: Request) {
  console.log('🔧 [OPTIONS /recipes]');
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}