// apps/api/src/app/api/test-ai/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { testGeminiConnection, callGeminiAPI } from '@/app/lib/agents/utils/llm';
import { apiHandler } from '@/app/lib/apiHandler';
import { requireCoachAuth } from '@/app/lib/auth';

async function getHandler(request: NextRequest) {
  try {
    // Seguridad: solo admin en producción (en desarrollo cualquiera puede probar)
    if (process.env.NODE_ENV === 'production') {
      const auth = requireCoachAuth(request);
      if (auth.role !== 'admin') {
        return NextResponse.json(
          { success: false, message: 'No autorizado', code: 'FORBIDDEN'},
          { status: 403 }
        );
      }
    }

    // Probar conexión con Gemini
    const isConnected = await testGeminiConnection();

    // Intentar un prompt simple
    const result = await callGeminiAPI({
      systemPrompt: "Responde SOLO con JSON válido.",
      userPrompt: 'Responde con este JSON exacto: {"test": "ok", "message": "Conexión exitosa con Gemini"}',
      temperature: 0,
      maxOutputTokens: 100,
      responseMimeType: "application/json",
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      parsed = { error: 'No es JSON', content: result.text };
    }

    return NextResponse.json({
      apiKeyPresent: !!process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
      connectionTest: isConnected,
      simpleRequest: {
        content: result.text?.substring(0, 200),
        parsed,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      error: message,
      apiKeyPresent: !!process.env.GEMINI_API_KEY,
      stack: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.stack : undefined) : undefined,
    }, { status: 500 });
  }
}

export const GET = apiHandler(getHandler);
