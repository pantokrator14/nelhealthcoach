// apps/api/src/app/api/exercises/[id]/upload/route.ts
// ─── COMENTADO: se preserva para futuro uso con GIFs ───
//
// Endpoints para subir/confirmar/eliminar demos (imágenes/GIFs/videos) de ejercicios.
//
// POST   → genera presigned URL para subir archivo a S3
// PUT    → confirma la subida y actualiza el demo en BD
// DELETE → elimina el demo del ejercicio y de S3

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  return NextResponse.json({ success: false, message: 'Upload de demos deshabilitado temporalmente', code: 'INTERNAL'}, { status: 503 });
}

export async function PUT(req: NextRequest) {
  return NextResponse.json({ success: false, message: 'Upload de demos deshabilitado temporalmente', code: 'INTERNAL'}, { status: 503 });
}

export async function DELETE(req: NextRequest) {
  return NextResponse.json({ success: false, message: 'Upload de demos deshabilitado temporalmente', code: 'INTERNAL'}, { status: 503 });
}
