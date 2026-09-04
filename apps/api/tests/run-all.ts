/**
 * RUNNER TDD CENTRAL — ejecuta la suite completa del proyecto.
 *
 * Uso:
 *   npx tsx tests/run-all.ts            → suite rápida (sin LLM real)
 *   npx tsx tests/run-all.ts --e2e      → suite completa (incluye LLM real, ~10 min)
 *
 * Orden: security-gate (inicio) → unit/integración → security-gate (fin).
 * Cada test usa perfiles desechables con limpieza garantizada en finally.
 */
import { spawnSync } from 'child_process';
import path from 'path';

const E2E = process.argv.includes('--e2e');

const suites = [
  'security-gate.test.ts',      // gate de seguridad (inicio)
  'auth.test.ts',               // auth + rate limit + validación
  'clients.test.ts',            // clients CRUD + ownership
  'content.test.ts',            // recipes + exercises CRUD + roles
  'notifications.test.ts',      // notifications + misc
  'error-cleanup.test.ts',      // POST limpia generationError viejo al encolar
  'queue.test.ts',              // cola propia (unit, sin LLM)
  'translate.test.ts',          // traducción (unit, mock LLM)
  'pdf-route.test.ts',          // route PDF real (LLM)
  'db-clean.test.ts',           // verificación final: DB sin datos de prueba
];

if (E2E) {
  suites.push(
    'translate-e2e.test.ts',    // traducción con LLM real
    'queue-e2e.test.ts',        // cola E2E con LLM real (~3 min)
    'regen-e2e.test.ts',        // regen E2E con LLM real (~4 min)
  );
}

let failures = 0;
const results: { name: string; ok: boolean }[] = [];

for (const suite of suites) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`▶ EJECUTANDO: ${suite}`);
  console.log(`${'═'.repeat(60)}\n`);

  const res = spawnSync('npx', ['tsx', path.join(__dirname, suite)], {
    stdio: 'inherit',
    shell: true,
    timeout: 15 * 60 * 1000,
  });

  const ok = res.status === 0;
  results.push({ name: suite, ok });
  if (!ok) failures++;
}

console.log(`\n${'═'.repeat(60)}`);
console.log(failures === 0
  ? '✅ TODAS LAS SUITES PASARON'
  : `❌ ${failures} SUITE(S) FALLARON`);
console.log(`${'═'.repeat(60)}`);
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);
}
process.exit(failures > 0 ? 1 : 0);
