# Voice + Business Rules merge reconciliation

## Estado verificado

- Voice se integró de forma no destructiva con `origin/main` en `512291bda6693bd7073130f61d4d85414d66e113`.
- Business Rules permanece como la verdad de `main`; Voice conserva grounding, StreamSid, recording y timing.
- No se debe ejecutar ninguna de estas migraciones sobre producción durante la reconciliación.

## Qué aportaba cada frente

Voice, antes de reconciliar `0002_round_pestilence.sql` y ahora `0003_illegal_kingpin.sql`:

- crea `call_timing_events` y su índice por call/created_at;
- agrega a `calls`: `twilio_stream_sid`, `recording_sid`, `recording_status`, `recording_url` y `recording_duration_seconds`;
- crea índices únicos para StreamSid y RecordingSid;
- agrega a `quotes`: caller item, transcript grounded y start/end raw.

Business Rules, `0002_perpetual_thunderbolts.sql`:

- reconstruye `campaigns` para admitir `BEST_WEIGHT_PRICE_RATIO`;
- agrega `operations.weight_kg NOT NULL DEFAULT 10000`.

Las migraciones SQL no modifican las mismas tablas: Voice toca `calls`, `quotes` y una tabla nueva; Business Rules toca `campaigns` y `operations`. El conflicto es de numeración/metadata Drizzle y de archivos TypeScript compartidos, no de columnas equivalentes.

## Conflictos resueltos

Confirmados y resueltos al integrar ambos lados desde `b6b0964`:

- `src/db/migrations/meta/0002_snapshot.json` — agregado distinto en ambos lados;
- `src/db/migrations/meta/_journal.json` — ambos registran un índice 2 diferente;
- `src/db/schema.ts` — debe conservar simultáneamente las reglas Business Rules y las columnas/tablas Voice;
- `src/modules/market/market.repository.ts` — ranking por peso/precio más persistencia de provenance;
- `src/modules/market/market.types.ts` — nueva estrategia más tipos/respuesta de grounding.

No se eligió un lado completo: se conservaron ambas conductas.

## Reconciliación ejecutada

1. Se hizo merge de `origin/main` dentro de `feat/voice-main-hardening`; no se modificó `main`.
2. Se conservaron los cambios TypeScript de ambos frentes.
3. `0002_perpetual_thunderbolts.sql`, su journal y snapshot permanecen como la migración Business Rules.
4. La identidad anterior `0002` de Voice se retiró y Drizzle generó `0003_illegal_kingpin.sql` con snapshot y journal coherentes.
5. La copia de datos de `calls` usa `actor_type='CARRIER'` para filas preexistentes, porque el snapshot de `main` ya declaraba esa columna aunque su SQL `0002` no la creaba.
6. El schema combinado contiene `weightKg`, `BEST_WEIGHT_PRICE_RATIO`, `actorType`, columnas Voice, `call_timing_events` y grounding de quote.
7. Se validaron dos caminos en SQLite desechable: base vacía `0000→0001→0002 Business→0003 Voice`, y base existente hasta `0002 Business→0003 Voice`.
8. Typecheck, todos los tests, OpenAPI/parity y `git diff --check` deben permanecer verdes antes del merge a `main`.

No renombrar migraciones a mano sin regenerar snapshot/journal y no editar la DB productiva.
