# TEST-BE-04 — Incidentes, escalación y ejecución sin voz

## Objetivo

Simular una llamada entrante de un conductor, registrar cambios dentro y fuera del mandato, escalar a un humano falso y confirmar pickup/delivery sin usar telefonía.

## Estado contractual

Este archivo describe el vertical slice objetivo. Si alguna ruta de incidents, escalations, execution o audit no está montada, responde `ROUTE_NOT_FOUND`, o la tool devuelve `503`, el resultado es `BLOCKED`; no debe sustituirse con escrituras directas para declarar `PASS`.

## Precondiciones

- `TEST-BE-01` puede crear una operación `BOOKED` con commitment `VALID`.
- El carrier ganador tiene un teléfono de prueba único.
- Se inyectan firma Twilio válida falsa, `FakeConferenceGateway` y `VoiceCorePort` real.
- Existe una call de prueba o puede crearse mediante el webhook entrante simulado.

## Flujo A — Llamada entrante simulada

### A1. Resolver un caller conocido

Invocar el service de voice webhook, o el endpoint local con una firma generada por el validador de prueba:

```http
POST /api/v1/webhooks/twilio/voice
Content-Type: application/x-www-form-urlencoded
X-Twilio-Signature: <firma-de-prueba-valida>

CallSid=CA_FAKE_INBOUND_001&From=%2B525500000001&To=%2B525500009999&CallStatus=ringing
```

Respuesta esperada:

- HTTP `200`, `Content-Type` XML/TwiML.
- El TwiML contiene `wss://<host>/ws/twilio-media/{callId}` y `<Parameter name="callId">`.
- Se crea una sola call `INBOUND`, relacionada con operación y carrier ganadores.
- El propósito se resuelve según el estado oficial, sin confiar en texto del caller.
- Existe un `CALL_RECEIVED` con el `CallSid`.

### A2. Repetir el mismo webhook

Enviar exactamente el mismo `CallSid`.

Respuesta esperada:

- HTTP `200` y TwiML funcional.
- Se reutiliza el mismo `callId`.
- No se crea una segunda call ni otro `CALL_RECEIVED`.

### A3. Caller desconocido o con varias operaciones

Probar un teléfono no registrado y, por separado, otro relacionado con varias operaciones activas.

Respuesta esperada:

- El teléfono desconocido falla cerrado con un código estable de caller no reconocido.
- Cuando hay varias operaciones, aplica la regla documentada de elegir la operación activa con `updatedAt` más reciente y devuelve exactamente su `operationId`; nunca elige al azar.
- No expone datos de clientes, rutas o contenedores ajenos.
- No crea una incidencia hasta resolver identidad y operación.

## Flujo B — Cambio permitido

### B1. Registrar incidencia

Enviar:

```http
POST /api/v1/operations/{operationId}/incidents
Content-Type: application/json

{
  "callId": "<inboundCallId>",
  "type": "GENERAL",
  "description": "El conductor llegará dos horas más tarde el mismo día, sin costo adicional.",
  "reportedBy": "Juan, conductor"
}
```

Respuesta esperada:

- HTTP `201`.
- Incidencia `OPEN`, relacionada con operación y call.
- `type` se conserva como etiqueta, pero no decide el resultado.
- Existe un solo evento de incidencia reportada.

### B2. Evaluar dentro del mandato

Enviar `POST /api/v1/incidents/{incidentId}/evaluate-change`:

```json
{
  "proposedPickupDate": "2026-09-03",
  "proposedTotalPrice": 8500,
  "notes": "Misma fecha y costo acordado."
}
```

Respuesta esperada:

- HTTP `200`.
- Evaluación `allowed: true`, `code: "ALLOWED"`, con el mandato activo.
- Incidencia `ALLOWED_CHANGE` o `RESOLVED` según el cierre explícito del service.
- No se crea mandato nuevo, escalación ni commitment.
- El agente puede informar que el cambio está permitido, pero no inventar términos adicionales.

## Flujo C — Cambio fuera del mandato y escalación

### C1. Registrar una segunda incidencia

Descripción: “Pickup el 4 de septiembre y 1,000 MXN adicionales”. La incidencia inicia `OPEN`.

### C2. Evaluar el cambio

```json
{
  "proposedPickupDate": "2026-09-04",
  "proposedTotalPrice": 9500,
  "notes": "Cambio solicitado por avería."
}
```

Respuesta esperada:

- HTTP `200`, `allowed: false`.
- Código y razones identifican fecha y/o precio fuera del mandato; no se acepta el cambio.
- Incidencia `NEEDS_ESCALATION`.
- La operación queda `ESCALATED` o en el estado de excepción definido, nunca `BOOKED` con términos modificados silenciosamente.

### C3. Solicitar escalación

Enviar:

```http
POST /api/v1/operations/{operationId}/escalations
Content-Type: application/json

{
  "callId": "<inboundCallId>",
  "incidentId": "<incidentId>",
  "reason": "OUTSIDE_MANDATE",
  "contextSummary": "Solicita pickup 4-sep y total 9,500 MXN; mandato activo permite 3-sep y 9,000 MXN.",
  "requestedHumanPhone": "+525500008888"
}
```

Respuesta esperada:

- HTTP `201`.
- Escalación `REQUESTED`, relacionada con call e incidencia.
- El resumen contiene hechos exactos y no cambia el mandato.
- Una segunda solicitud equivalente reutiliza la escalación activa o responde `409`; nunca crea dos joins.

### C4. Unir al humano falso

Enviar `POST /api/v1/escalations/{escalationId}/join-human`.

Respuesta esperada:

- HTTP `202`.
- Estado inmediato `DIALING_HUMAN`.
- `FakeConferenceGateway` se invoca exactamente una vez con la call activa y teléfono solicitado/autorizado.
- Al simular aceptación, estado `HUMAN_JOINED`.
- La call original permanece `IN_PROGRESS`; no se cuelga ni se reemplaza.

### C5. Autorizar una excepción mediante mandato v2

El operador, no Logistics Agent, envía `POST /api/v1/operations/{operationId}/mandates/versions`:

```json
{
  "maxTotalPrice": 9500,
  "currency": "MXN",
  "pickupDate": "2026-09-04",
  "notes": "Excepción autorizada por operador durante escalación."
}
```

Respuesta esperada:

- HTTP `201`, mandato v2 `ACTIVE`.
- Mandato v1 queda `SUPERSEDED` e inmutable.
- El Logistics Agent debe volver a consultar el mandato; no basta la frase del humano.
- Repetir la evaluación contra v2 produce `allowed: true` y referencia `mandateV2Id`.
- La escalación puede pasar a `RESOLVED`; la auditoría conserva quién autorizó.

## Flujo D — Pickup y delivery

Restaurar/preparar una operación con commitment `VALID` y términos vigentes.

### D1. Rechazar pickup prematuro

Intentar confirmar pickup en una operación sin commitment `VALID`.

Respuesta esperada:

- HTTP `409 VALID_COMMITMENT_REQUIRED`.
- Operación y commitment no cambian.
- No existe `PICKUP_CONFIRMED`.

### D2. Confirmar pickup válido

Enviar:

```http
POST /api/v1/operations/{operationId}/pickup/confirm
Content-Type: application/json

{
  "callId": "<executionCallId>",
  "occurredAt": "2026-09-04T14:00:00.000Z",
  "confirmedBy": "Juan, conductor",
  "notes": "Contenedor recogido en Manzanillo."
}
```

Respuesta esperada:

- HTTP `200`.
- La respuesta final deja la operación `IN_TRANSIT`; la transición conceptual incluye `PICKED_UP` y queda registrada en auditoría/payload.
- Commitment `IN_EXECUTION`.
- Un solo `PICKUP_CONFIRMED` ligado a call, operador logístico y timestamp.
- Repetir la misma confirmación es idempotente o responde `409`, sin segundo evento.

### D3. Rechazar delivery antes de pickup

En un fixture aparte, confirmar delivery desde `BOOKED`.

Respuesta esperada:

- HTTP `409 INVALID_STATE_TRANSITION`.
- No existe `DELIVERY_CONFIRMED`.

### D4. Confirmar delivery válido

Desde `IN_TRANSIT`, enviar:

```http
POST /api/v1/operations/{operationId}/delivery/confirm
Content-Type: application/json

{
  "callId": "<deliveryCallId>",
  "occurredAt": "2026-09-04T22:00:00.000Z",
  "confirmedBy": "Juan, conductor",
  "notes": "Entregado en Guadalajara."
}
```

Respuesta esperada:

- HTTP `200`.
- La respuesta final deja la operación `COMPLETED`; la transición conceptual incluye `DELIVERED` y queda registrada en auditoría/payload.
- Commitment `FULFILLED`.
- Un solo `DELIVERY_CONFIRMED`.
- No se modifican precio, carrier, mandato ni evidencia del acuerdo.

## Verificación de auditoría

`GET /api/v1/operations/{operationId}/audit-events` debe responder HTTP `200` con una secuencia suficiente para reconstruir:

1. caller y call resueltos;
2. las dos incidencias;
3. evaluación permitida y evaluación rechazada;
4. escalación solicitada, humano unido y resolución;
5. mandato v1 superado por v2;
6. pickup y delivery confirmados.

Cada evento debe relacionar `operationId` y, cuando aplique, `callId`, `incidentId`, `escalationId`, `mandateId` y actor. No se admiten datos personales completos en payloads innecesarios.

## Criterio global

`PASS` exige todas las rutas, transiciones y auditoría descritas, sin gateway real. Un 404 de ruta, 503 del core, join que cuelga la call o ejecución sin commitment válido deja el caso en `BLOCKED`/`FAIL` y señala exactamente el primer paso no soportado.
