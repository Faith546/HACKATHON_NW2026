# Revisión diferencial — recepción de llamadas Twilio

## Executive Summary

| Severity | Count |
|---|---:|
| 🔴 CRITICAL | 0 |
| 🟠 HIGH | 2 |
| 🟡 MEDIUM | 2 |
| 🟢 LOW | 0 |

**Overall Risk:** HIGH  
**Recommendation:** CONDITIONAL — no ejecutar el E2E PSTN hasta comprobar el `From` real de Twilio, habilitar observabilidad de entrada y evitar que recording sea una dependencia bloqueante del agente.

**Key Metrics:**

- Rango revisado: `3d942a4..aeaec88`.
- 52 archivos modificados; 10 archivos de la ruta Twilio analizados en detalle.
- 100% de los cambios de entrada HTTP, identidad de operador, firma, Media Stream y recording revisados.
- `npm run typecheck`: PASS.
- `npm test`: 97/108 PASS; 11 FAIL por SQLite local sin `quotes.grounded_caller_item_id`.
- La ruta `/api/v1/webhooks/twilio/voice` continúa montada y sus pruebas unitarias pasan.

## What Changed

**Commit Range:** `3d942a4..aeaec88`  
**Timeline:** 2026-08-29 22:24–22:30 America/Mexico_City

```text
3d942a4 baseline
  ├─ 65e92bd E2E: operador autorizado + flujo autónomo
  ├─ 13765a2 hardening: StreamSid + recording + timing
  └─ aeaec88 merge final de Voice hardening
```

| File | +Lines | -Lines | Risk | Blast Radius |
|---|---:|---:|---|---|
| `src/server.ts` | 43 | 11 | HIGH | MEDIUM |
| `src/modules/voice/drizzle-voice-core.adapter.ts` | 24 | 1 | HIGH | LOW |
| `src/modules/realtime/twilio-media.bridge.ts` | 185 | 24 | HIGH | LOW |
| `src/modules/recordings/recordings.service.ts` | 130 | 0 | HIGH | LOW |
| `src/modules/webhooks/*` | 59 | 0 | HIGH | MEDIUM |

## Critical Findings

### 🟠 HIGH: número de operador no coincidente corta el webhook sin ningún log

**Files:** `src/server.ts:118-172`, `src/modules/voice/drizzle-voice-core.adapter.ts:216-240`, `src/shared/http/error-handler.ts:21-68`  
**Commit:** `65e92bd`  
**Blast Radius:** entrada PSTN de todos los operadores configurados  
**Test Coverage:** PARTIAL

**Description:** El cambio agregó `AUTHORIZED_OPERATOR_PHONES` y reconoce al operador únicamente mediante igualdad exacta entre `body.From.trim()` y una entrada del `Set`. Si Twilio envía una representación distinta —por ejemplo un E.164 diferente al valor escrito en Railway— el código busca el mismo teléfono como carrier y termina en `422 INBOUND_CALLER_UNKNOWN`. `receiveVoice()` no genera TwiML en ese caso, por lo que Twilio reproduce un error de aplicación o termina la llamada.

El manejador HTTP no registra `ApiError`; sólo serializa la respuesta. Por eso el comportamiento observable coincide exactamente con “la llamada falla y Railway no muestra ningún log”.

**Historical Context:**

- `git log -S AUTHORIZED_OPERATOR_PHONES` atribuye la introducción a `65e92bd E2E`.
- No se eliminó una validación anterior; se agregó una frontera de autorización necesaria, pero sin telemetría operacional.

**Concrete Failure Scenario:**

1. Railway contiene `AUTHORIZED_OPERATOR_PHONES=+521...`.
2. Twilio envía `From=+52...` o cualquier cadena E.164 que no sea idéntica.
3. `resolveInboundCallContext()` no reconoce al operador.
4. No existe carrier activo con ese teléfono y lanza `INBOUND_CALLER_UNKNOWN`.
5. El error handler responde HTTP 422 sin escribir en consola.
6. Twilio no recibe TwiML y la persona oye un error.

**Recommendation:** Comparar `AUTHORIZED_OPERATOR_PHONES` con el `From` exacto mostrado por Twilio Request Inspector. Añadir logging sanitizado del webhook (`CallSid`, últimos cuatro dígitos de `From`, status, request ID y código de respuesta), sin registrar tokens ni números completos.

### 🟠 HIGH: iniciar recording es ahora bloqueante y sus fallos se descartan

**Files:** `src/modules/realtime/twilio-media.bridge.ts:62-76`, `src/modules/realtime/twilio-media.bridge.ts:110-163`, `src/modules/recordings/recordings.service.ts:45-80`  
**Commit:** `13765a2 feat(voice): harden call facts and media identity`  
**Blast Radius:** todos los Media Streams inbound y outbound  
**Test Coverage:** PARTIAL

**Description:** Después del evento `start`, `handleConnection()` ejecuta `await recordingService.start(callId)` antes de crear la sesión Realtime y conectar OpenAI. Cualquier rechazo de la API de recording impide que el agente conteste. El `catch` de `attach()` descarta el objeto de error y sólo cierra el WebSocket con código 1011, por lo que Railway tampoco explica el fallo.

Además, los logs `[TWILIO] connected` y `[TWILIO] start` se registran después de esta cadena de `await`; un error temprano de identidad, base de datos o recording ocurre antes de que esos listeners produzcan evidencia visible.

**Concrete Failure Scenario:**

1. El webhook devuelve TwiML y Twilio abre el WebSocket.
2. El Stream envía un `CallSid` válido.
3. `TwilioRecordingGateway.start()` recibe un rechazo de Twilio por permisos, estado de llamada, cuenta o configuración de recording.
4. `RecordingService` marca `FAILED` y relanza el error.
5. `attach()` lo descarta y cierra el socket como `Realtime bridge failed`.
6. OpenAI nunca se conecta; la llamada queda en silencio o termina y no aparece ningún log `[TWILIO]`.

**Recommendation:** Hacer recording no bloqueante para la disponibilidad de voz, o fallar con un mensaje/log explícito. Como mínimo, cambiar el `catch(() => ...)` por un `catch((error) => console.error(...))` sanitizado y registrar el upgrade antes de validar/esperar servicios externos.

### 🟡 MEDIUM: no existe observabilidad en las dos fronteras de entrada

**Files:** `src/modules/webhooks/webhooks.controller.ts:38-49`, `src/modules/webhooks/webhooks.service.ts:40-74`, `src/modules/realtime/twilio-media.bridge.ts:62-76`  
**Commit:** comportamiento anterior conservado; el riesgo creció con los nuevos puntos de fallo  
**Blast Radius:** todos los webhooks y upgrades Twilio  
**Test Coverage:** NO

No hay log al recibir el POST, al aceptar/rechazar firma HTTP, al resolver identidad del llamante, al aceptar/rechazar upgrade WSS ni al fallar `handleConnection`. Por tanto, la ausencia de logs no permite distinguir entre: Twilio no llamó al host, firma 403, operador 422, WSS 403 o recording/OpenAI 1011.

### 🟡 MEDIUM: el servidor puede arrancar correctamente en modo local

**File:** `src/server.ts:118-155`  
**Commit:** preexistente; el nuevo flujo de operador depende de esta configuración  
**Blast Radius:** todo Media Stream real  
**Test Coverage:** PARTIAL

`VOICE_RUNTIME_MODE` usa `local` por defecto. En ese modo el proceso imprime API/Swagger/OpenAPI y parece saludable, pero `TwilioMediaBridge` no se adjunta. El log de startup no muestra el modo efectivo. Si Railway no define exactamente `VOICE_RUNTIME_MODE=twilio`, el webhook puede devolver una URL WSS pero el servidor no tiene handler para aceptarla.

## Function Micro-Analysis

### `WebhooksService.receiveVoice()` — `webhooks.service.ts:40-74`

**Purpose:** Es la frontera que transforma un webhook PSTN autenticado en una llamada interna y devuelve el TwiML que abre el Media Stream. Su éxito determina si Twilio tiene instrucciones válidas para contestar la llamada.

**Inputs & Assumptions:**

- `body` proviene de formulario externo y no es confiable.
- `request.signature` debe corresponder al Auth Token de la misma cuenta.
- `request.requestUrl` debe reconstruir exactamente la URL configurada en Twilio.
- `CallSid`, `From` y `To` deben estar presentes y normalizados por Twilio.
- `voiceCore` debe reconocer al operador o a un carrier activo.
- `PUBLIC_WSS_URL` debe ser público y usar `wss:`.

**Outputs & Effects:**

- Devuelve XML TwiML con `<Connect><Stream>`.
- Puede crear una fila `calls` y asociar el `CallSid`.
- Puede actualizar el estado de la llamada.
- Cruza la frontera hacia SQLite mediante `CallsService`/`VoiceCore`.
- Puede terminar en 403, 422 o 503 antes de devolver XML.

**Invariants:**

- Ninguna mutación debe ocurrir antes de validar la firma.
- Un `CallSid` sólo puede pertenecer a una llamada interna.
- El Stream debe transportar el `callId` persistido.

**Block-by-Block Analysis:**

- L44 valida firma primero. **Why:** evita crear llamadas desde tráfico falsificado. **5 Whys:** la URL exacta importa porque Twilio la incluye en la firma; un dominio distinto causa 403 aunque el token sea correcto.
- L45-50 recupera o crea idempotentemente. **Why:** Twilio puede reintentar. **5 Hows:** la resolución propaga `From` hacia autorización exacta, luego hacia SQLite y finalmente hacia el `callId` del Stream.
- L51-59 aplica estado conocido. **Why:** conserva correlación entre proveedor y dominio interno. **Assumption:** el estado recibido pertenece al mismo `CallSid`.
- L60-67 exige `wss:`. **First Principles:** una llamada de audio bidireccional requiere un canal seguro y alcanzable; una URL sintácticamente válida no garantiza reachability.
- L68-74 genera TwiML. **5 Hows:** base WSS → path de Stream → `callId` → parámetro custom → validación posterior de identidad.

**Cross-Function Dependencies:**

- Llama a `validateSignature()`, `CallsService.findByProviderCallId()`, `createInboundCall()`, `applyProviderStatus()` y `createMediaStreamTwiml()`.
- Es llamado por `WebhooksController.receiveVoice()`.
- Comparte el invariante de identidad con `TwilioMediaBridge.validateTwilioStartContext()`.
- Riesgos externos: reintentos de Twilio, URL firmada distinta y datos `From/To` no coincidentes con configuración.

### `DrizzleVoiceCoreAdapter.resolveInboundCallContext()` — `drizzle-voice-core.adapter.ts:216-240`

**Purpose:** Autoriza al llamante y asigna su rol/purpose antes de crear una llamada. El cambio reciente permite al operador interno iniciar `OPERATIONS` sin seleccionar silenciosamente una operación.

**Inputs & Assumptions:**

- `fromNumber` viene de Twilio y es externo.
- La lista autorizada proviene de Railway y se cargó al inicio.
- Ambas cadenas usan la misma representación E.164.
- Los teléfonos de carriers son únicos y están normalizados.
- La base migrada contiene las columnas nuevas de `calls`.

**Outputs & Effects:**

- Para operador devuelve `INTERNAL_OPERATOR`, `OPERATIONS` y contexto nulo.
- Para otro llamante consulta carrier/operación/negociación.
- No escribe por sí mismo, pero su resultado controla la creación posterior de la call.
- Lanza 422 cuando no existe identidad permitida.

**Invariants:**

- Sólo un teléfono configurado obtiene capacidades de operador.
- Un operador no hereda silenciosamente una operación activa.
- Un desconocido no puede abrir sesión con tools privilegiadas.

**Block-by-Block Analysis:**

- L220 compara el `Set`. **First Principles:** el teléfono funciona como credencial; la igualdad estricta maximiza fail-closed, pero exige normalización común.
- L221-227 devuelve contexto privilegiado sin operación. **Why here:** debe ejecutarse antes de consultar carriers para evitar confundir roles. **5 Whys:** el contexto nulo obliga a la conversación a resolver o crear explícitamente la operación.
- L229-240 busca carrier o rechaza. **5 Hows:** `From` no autorizado → query exacta → ausencia → ApiError 422 → error handler JSON → Twilio sin TwiML.

**Cross-Function Dependencies:**

- Es llamado desde `WebhooksService.createInboundCall()` y el facade de integración.
- Depende del parser de `AUTHORIZED_OPERATOR_PHONES` de `server.ts`.
- Su salida alimenta `CallsService.createOrGetInbound()` y luego `RealtimeService.create()`.
- Riesgos: variantes E.164, caller-ID oculto/alterado y configuración de Railway desactualizada.

### `TwilioMediaBridge.handleConnection()` — `twilio-media.bridge.ts:110-419`

**Purpose:** Correlaciona el WebSocket con la call persistida, abre recording/timing, crea la sesión de dominio y conecta OpenAI Realtime. Es el camino único que convierte una llamada contestada por Twilio en conversación audible.

**Inputs & Assumptions:**

- El upgrade ya pasó firma Twilio.
- El path contiene un `callId` existente.
- Twilio envía `start` dentro de 10 segundos con `CallSid`, `StreamSid` y custom `callId`.
- SQLite contiene y acepta las columnas de identidad/recording/timing.
- La cuenta Twilio permite crear recording durante la llamada.
- La API key/modelo de OpenAI permiten Realtime.

**Outputs & Effects:**

- Persiste `StreamSid`, estado de call, recording y timing.
- Crea una sesión Realtime y registra cierre/transcript.
- Abre conexión externa a Twilio Recording API y OpenAI.
- Puede cerrar WSS con 1008/1011.
- No retorna contenido HTTP; opera sobre el socket.

**Invariants:**

- `callId`, `CallSid` y `StreamSid` deben identificar la misma llamada.
- Una sesión no debe ejecutar tools antes de persistir transcript previo.
- Un Stream no debe reutilizarse entre llamadas.

**Block-by-Block Analysis:**

- L114-126 prepara transporte/captura antes de awaits. **Why:** Twilio no reenvía `start`. **5 Hows:** socket → listener síncrono → DB call → start → identidad.
- L127-142 valida y persiste identidad. **First Principles:** la correlación debe establecerse antes de aceptar audio o mutaciones.
- L143 inicia recording de forma bloqueante. **5 Whys:** se colocó antes de Realtime para asegurar evidencia, pero eso acopla disponibilidad de conversación a una API secundaria.
- L144-170 persiste timing y crea contexto. **Assumption:** cualquier write SQLite termina a tiempo y no falla por esquema/bloqueo.
- L207-240 crea agente/sesión OpenAI. **5 Hows:** call purpose → mode → tools → agent → transporte Twilio → OpenAI.
- L317-398 registra eventos sólo después de todas las operaciones anteriores. **Why problematic:** los fallos tempranos no alcanzan esta observabilidad.
- L419 conecta OpenAI. **Risk:** credencial/modelo externos pueden rechazar; el listener `error` cierra la llamada.

**Cross-Function Dependencies:**

- Es llamado sólo por el upgrade handler de `attach()`.
- Depende de CallsService, RecordingService, TimingService y RealtimeService.
- Cruza dos servicios externos: Twilio Recording API y OpenAI Realtime.
- Sus invariantes se acoplan con el TwiML generado por `receiveVoice()` y con las migraciones `0003/0004`.

## Test Coverage Analysis

Las pruebas específicas de webhook, autorización del operador, identidad de Stream y RecordingService pasan. Sin embargo, sólo prueban componentes aislados.

| Untested change | Risk | Impact |
|---|---|---|
| POST firmado real → operador exacto → TwiML | HIGH | No detecta variantes reales de `From` ni URL proxy |
| WSS firmado real → recording rechazado | HIGH | No detecta que el agente nunca conecta |
| logging de 403/422/1011 | HIGH | No existe prueba porque no existe observabilidad |
| startup Railway en `local` vs `twilio` | MEDIUM | El proceso puede parecer sano sin bridge |

La suite completa no está verde: 11 fallos por un SQLite local sin la migración `0004`. No prueba que Railway tenga el mismo problema porque los logs de Railway reportaron migraciones aplicadas, pero invalida el gate global del runbook hasta ejecutar la suite contra una base migrada/temporal coherente.

## Blast Radius Analysis

| Function | Production callers | Risk | Priority |
|---|---:|---|---|
| `receiveVoice()` | 1 | HIGH | P1 |
| `resolveInboundCallContext()` | 2 rutas | HIGH | P1 |
| `handleConnection()` | 1 | HIGH | P1 |
| `errorHandler()` | todas las rutas Express | MEDIUM | P1 observabilidad |

## Historical Context

- No se encontró eliminación de validaciones de firma o autorización.
- `65e92bd` agregó la autorización por número exacto y la variable obligatoria.
- `13765a2` agregó identidad StreamSid, recording y timing; el inicio de recording quedó en el camino crítico.
- El descarte silencioso del error en `TwilioMediaBridge.attach()` es anterior, pero su impacto aumentó al agregarse más operaciones susceptibles de fallar antes de OpenAI.

## Recommendations

### Immediate (Blocking)

- [ ] Abrir Twilio Request Inspector y copiar el `From` exacto a `AUTHORIZED_OPERATOR_PHONES`.
- [ ] Confirmar que el POST devuelve 200 XML; si devuelve 403, alinear `PUBLIC_BASE_URL`/Auth Token; si devuelve 422, corregir el teléfono.
- [ ] Confirmar `VOICE_RUNTIME_MODE=twilio` y registrar el modo efectivo al arrancar.
- [ ] Registrar recepción/respuesta del webhook y rechazo/aceptación del upgrade WSS.
- [ ] Registrar el error real capturado por `handleConnection()`.
- [ ] Evitar que un fallo de recording impida conectar OpenAI, salvo que recording sea un requisito legal explícito y entonces devolver una causa audible/observable.

### Before Production

- [ ] Agregar una prueba de integración del flujo HTTP+WSS con firma y fallo de recording.
- [ ] Ejecutar pruebas sobre SQLite temporal migrado; la suite completa debe quedar verde.
- [ ] Verificar que recording esté permitido por consentimiento y por el runbook, que actualmente indica no habilitar grabación.

## Analysis Methodology

**Strategy:** FOCUSED sobre un repositorio mediano (134 archivos `src/tests`).

**Techniques:**

- Diff `3d942a4..aeaec88` y revisión de commits/merge graph.
- Git blame y búsquedas `git log -S` para autorización y recording.
- Trazado línea por línea POST → autorización → persistencia → TwiML → WSS → recording → OpenAI.
- Conteo de callers y revisión de pruebas.
- Modelado de fallos externos y de fronteras de confianza.

**Limitations:**

- No existe acceso a las variables del servicio Railway ni a Twilio Console.
- No se realizó una llamada real ni se usaron credenciales.
- Sin Request Inspector no se puede decidir de forma concluyente entre HTTP 403, HTTP 422, WSS 403 o WSS 1011.

**Confidence:** HIGH sobre la explicación de por qué Railway queda sin logs; MEDIUM-HIGH sobre la causa primaria de la llamada, siendo `AUTHORIZED_OPERATOR_PHONES` el candidato más consistente con el cambio reciente y los síntomas.
