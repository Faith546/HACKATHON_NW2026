# Voice + Business Rules merge plan

## Estado verificado

- Voice: `feat/voice-main-hardening` en `a10fcfb8fdebca8718fdf2bf437beef53a26ae54`, basada en `b6b0964`.
- Business Rules ya llegó a `origin/main` en `63fd6390219aff4e00340e8638afc70af28a5c85` mediante `c7a14e1`.
- No se debe ejecutar ninguna de estas migraciones sobre producción durante la reconciliación.

## Qué agrega cada migration 0002

Voice, `0002_round_pestilence.sql`:

- crea `call_timing_events` y su índice por call/created_at;
- agrega a `calls`: `twilio_stream_sid`, `recording_sid`, `recording_status`, `recording_url` y `recording_duration_seconds`;
- crea índices únicos para StreamSid y RecordingSid;
- agrega a `quotes`: caller item, transcript grounded y start/end raw.

Business Rules, `0002_perpetual_thunderbolts.sql`:

- reconstruye `campaigns` para admitir `BEST_WEIGHT_PRICE_RATIO`;
- agrega `operations.weight_kg NOT NULL DEFAULT 10000`.

Las migraciones SQL no modifican las mismas tablas: Voice toca `calls`, `quotes` y una tabla nueva; Business Rules toca `campaigns` y `operations`. El conflicto es de numeración/metadata Drizzle y de archivos TypeScript compartidos, no de columnas equivalentes.

## Conflictos probables

Confirmados por comparación de ambos lados desde `b6b0964`:

- `src/db/migrations/meta/0002_snapshot.json` — agregado distinto en ambos lados;
- `src/db/migrations/meta/_journal.json` — ambos registran un índice 2 diferente;
- `src/db/schema.ts` — debe conservar simultáneamente las reglas Business Rules y las columnas/tablas Voice;
- `src/modules/market/market.repository.ts` — ranking por peso/precio más persistencia de provenance;
- `src/modules/market/market.types.ts` — nueva estrategia más tipos/respuesta de grounding.

No hay que elegir un lado completo: ambos cambios son ortogonales y deben conservarse.

## Reconciliación correcta

1. Crear una branch de integración desde el `origin/main` vigente; no hacerlo sobre producción.
2. Aplicar los commits Voice y resolver los cinco archivos compartidos conservando ambas conductas.
3. Mantener intactos `0002_perpetual_thunderbolts.sql`, su entrada de journal y su snapshot, porque ya pertenecen a `main`.
4. Retirar del resultado integrado únicamente la identidad Drizzle `0002` de Voice y regenerar sus cambios de schema contra el `main` actual con `npm run db:generate`; el resultado debe ser una migración Voice posterior, normalmente `0003`.
5. Verificar que el schema combinado contiene `weightKg`, `BEST_WEIGHT_PRICE_RATIO`, columnas Voice, `call_timing_events` y grounding de quote.
6. Probar dos caminos en SQLite desechable: base vacía `0000→0001→0002 Business→0003 Voice`, y copia no productiva ya migrada hasta `0002 Business→0003 Voice`.
7. Ejecutar typecheck, todos los tests, OpenAPI/parity y `git diff --check` antes de considerar merge.

No renombrar archivos a mano sin regenerar snapshot/journal; no editar la DB productiva; no resolver este conflicto dentro de `feat/voice-main-hardening`.
