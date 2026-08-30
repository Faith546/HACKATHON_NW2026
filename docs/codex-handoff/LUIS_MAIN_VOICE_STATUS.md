# Luis — Main Voice status

## DONE_CODE

- Baseline Express de `origin/main` conservado; no se portó Fastify.
- Quotes de Voice exigen amount + currency en transcript final originado por audio del caller.
- Se rechazan agent-only money, texto programático, turnos parciales/interrumpidos y confirmación “sí” sin monto.
- Quote guarda provenance mínimo: callId, caller item, transcript, start/end raw, cents y currency.
- CallSid + StreamSid se asocian de forma única y se rechazan mismatches/cross-call.
- Recording inicia después de CallSid/StreamSid válido, guarda Sid/status/URL/duración (no blob), y sus callbacks son idempotentes.
- Timing conserva eventos raw separados para `twilio_stream`, `openai_input`, `recording` y `local_observation`.
- Migración Drizzle mínima y tests deterministas agregados.

## NEEDS_DEPLOYMENT_CONFIG

- Railway debe usar `HOST=0.0.0.0`, volumen/`SQLITE_PATH` persistente y ejecutar migraciones.
- Confirmar SHA, Root Directory, start command, URLs públicas y variables del checklist.
- Actualizar el número Twilio si todavía apunta a ngrok; no se cambió desde esta tarea.

## NEEDS_PHYSICAL_TEST

- Gate inbound mínimo con oferta explícita de 8,500 MXN.
- ONE OUTBOUND, después THREE CALL, después TAKEOVER.
- Verificar continuidad real de recording/Media Stream al redirigir a Conference.
- Verificar comportamiento seguro si el humano no contesta.

## BLOCKED_BY_BACKEND

- `UNIQUE(negotiation_id)` y el estado terminal `QUOTED` siguen impidiendo revisiones 8,500 → 10,000.
- Backend debe definir contrato/schema de quote candidate/revision y dedup persistente. Voice no creó Round2, ranking, top2 ni winner.
- `JOINT_BACKEND`: después del último fetch apareció `origin/feat/business-rules` (`c7a14e1`) con su propia migración `0002` y cambios en `schema.ts`, Market y `twilio-media.bridge.ts`. No implementa revisions, pero antes de integrar ambas branches el owner de backend debe reconciliar/renumerar las migraciones y resolver esos archivos compartidos; esta tarea no mezcló ni sobrescribió esa branch.

## BLOCKED_BY_AGENTS

- Ningún bloqueo de AGENTS detectado en esta branch. La capa es backend/runtime y no pisa prompts/policies de otro owner.

## OPTIONAL_P1

- Agregar anchors Twilio Recording/stream comprobables para resolver alignment temporal; por ahora es `UNRESOLVED` con `RECORDING_START_OFFSET_UNKNOWN`.
- Definir recuperación explícita del carrier si el humano no entra a Conference.
- Exponer una vista de diagnóstico de timing si el equipo necesita inspección HTTP además de SQLite/logs.
