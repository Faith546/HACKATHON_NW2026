# TEST-BE-02 — Realtime y transcript sin audio

## Objetivo

Validar selección de agente, aislamiento de tools, argumentos estructurados, interrupciones, transcript y cierre de sesiones Realtime sin conectar OpenAI, Twilio, WebSockets ni dispositivos de audio.

## Método

Esta prueba usa directamente `CallsService` y `RealtimeService` con repositories en memoria o SQLite temporal, un `VoiceCorePort` espía que delega al core y un reloj controlado. No intenta imitar audio; inyecta segmentos ya transcritos.

## Precondiciones

- `TEST-BE-00` está en `PASS`.
- Existe una operación con mandato activo, un carrier y una negociación.
- Existen calls falsas para cada modo probado.
- El espía guarda nombre, contexto y argumentos de cada tool ejecutada.

## Matriz de tools esperada

| Modo | Agente permitido | Tools exactas |
|---|---|---|
| `CREATE_OPERATION` | `OPERATIONS_AGENT` | `createOperation`, `createMandate` |
| `QUOTE` | `LOGISTICS_AGENT` | `getActiveMandate`, `evaluateOffer`, `recordQuote`, `reportNoAnswer`, `saveCallBrief` |
| `COMMIT` | `LOGISTICS_AGENT` | `getActiveMandate`, `getAuthorizedCommitment`, `recordVerbalAgreement`, `attachCommitmentEvidence`, `enqueueCommitmentSummary`, `saveCallBrief` |
| `INCIDENT` | `LOGISTICS_AGENT` | `getOperation`, `getActiveMandate`, `reportIncident`, `evaluateIncidentChange`, `requestEscalation`, `saveCallBrief` |
| `EXECUTION` | `LOGISTICS_AGENT` | `getOperation`, `getActiveMandate`, `confirmPickup`, `reportIncident`, `requestEscalation`, `saveCallBrief` |
| `DELIVERY` | `LOGISTICS_AGENT` | `getOperation`, `confirmDelivery`, `reportIncident`, `requestEscalation`, `saveCallBrief` |

No se aceptan tools adicionales aunque el core pudiera ejecutarlas.

## Flujo A — Creación y contexto

### A1. Crear sesión QUOTE válida

Crear una call `OUTBOUND/QUOTE` relacionada con operación, carrier y negociación. Enviar:

```http
POST /api/v1/realtime/sessions
Content-Type: application/json

{
  "callId": "<callId>",
  "actorType": "CARRIER",
  "operationId": "<operationId>",
  "carrierId": "<carrierId>",
  "negotiationId": "<negotiationId>",
  "mode": "QUOTE"
}
```

Respuesta esperada:

- HTTP `201`.
- `agent: "LOGISTICS_AGENT"`, `mode: "QUOTE"`, `status: "ACTIVE"`.
- `mandateId` es el mandato activo.
- `allowedTools` coincide exactamente con la matriz.
- La call queda vinculada al `sessionId`.
- Auditoría contiene un `REALTIME_SESSION_CREATED`.

### A2. Rechazar contexto inventado

Repetir con un `carrierId`, `operationId` o `negotiationId` que no corresponda a la call.

Respuesta esperada:

- HTTP/service error `422` con `code: "REALTIME_CONTEXT_MISMATCH"`.
- `details.field` identifica la relación incorrecta.
- No se crea sesión ni se modifica la call.

### A3. Rechazar combinación de agente y modo

Intentar `actorType: "INTERNAL_OPERATOR"` con `mode: "QUOTE"`, y `actorType: "CARRIER"` con `mode: "CREATE_OPERATION"`.

Respuesta esperada en ambos casos:

- Error `403`, `code: "REALTIME_MODE_FORBIDDEN"`.
- Cero ejecución de tools y cero sesión persistida.

## Flujo B — Barrera estructural de tools

### B1. Ejecutar una tool permitida

Invocar en la sesión QUOTE:

```json
{
  "name": "recordQuote",
  "arguments": {
    "totalPrice": 8500,
    "currency": "MXN",
    "pickupDate": "2026-09-03",
    "validUntil": "2026-09-01T14:00:00.000Z",
    "dispatcherName": "Laura"
  }
}
```

Respuesta esperada:

- El espía observa exactamente una ejecución `recordQuote`.
- El contexto contiene los IDs de la sesión, no IDs proporcionados por el simulador.
- La quote se valida y persiste mediante el service oficial.

### B2. Rechazar una tool prohibida

Invocar `createMandate` y después `recordVerbalAgreement` en la misma sesión QUOTE.

Respuesta esperada por intento:

- Error `403`, `code: "REALTIME_TOOL_FORBIDDEN"`.
- `details` identifica nombre y modo.
- El espía del core no recibe la invocación.
- Mandato y commitments permanecen iguales.

### B3. Rechazar argumentos inválidos

Invocar `recordQuote` sin moneda y después con `totalPrice: -1`.

Respuesta esperada:

- Error `422`, con código estable de argumentos de tool inválidos.
- Los detalles contienen los campos inválidos.
- No se persiste quote ni se ejecuta el core.

## Flujo C — Transcript e interrupción

Agregar, fuera de orden, los segmentos:

```json
[
  {
    "id": "turn_2",
    "speaker": "AGENT",
    "startMs": 1000,
    "endMs": 1800,
    "text": "Entiendo, el precio sería...",
    "final": true,
    "interrupted": true
  },
  {
    "id": "turn_1",
    "speaker": "HUMAN",
    "startMs": 100,
    "endMs": 900,
    "text": "Puedo hacerlo por ocho mil quinientos.",
    "final": true,
    "interrupted": false
  },
  {
    "id": "turn_3",
    "speaker": "HUMAN",
    "startMs": 1700,
    "endMs": 2400,
    "text": "La fecha es el tres de septiembre.",
    "final": true,
    "interrupted": false
  }
]
```

Respuesta esperada al cerrar:

```text
[0.1s] HUMAN: Puedo hacerlo por ocho mil quinientos.
[1.0s] AGENT: Entiendo, el precio sería... [INTERRUMPIDO]
[1.7s] HUMAN: La fecha es el tres de septiembre.
```

Además:

- el orden se determina por `startMs`, no por llegada;
- los campos `speaker`, offsets e interrupción se conservan;
- segmentos vacíos no aparecen;
- se persiste un solo transcript consolidado;
- no se guarda audio, recording SID ni URL.

## Flujo D — Cierre e idempotencia

### D1. Cerrar la sesión

Enviar `DELETE /api/v1/realtime/sessions/{sessionId}`.

Respuesta esperada:

- HTTP `204` sin body.
- La call conserva el transcript y pierde el vínculo `realtimeSessionId`.
- La sesión ya no está activa.
- Existe un `TRANSCRIPT_SAVED` y un `REALTIME_SESSION_CLOSED`.

### D2. Repetir el cierre

Cerrar por segunda vez el mismo ID.

Respuesta correcta:

- La operación es idempotente: no duplica transcript, eventos ni efectos.
- Puede devolver `204` nuevamente o un `404 RESOURCE_NOT_FOUND` documentado; la suite debe fijar una única decisión contractual antes de automatizarla. Mientras OpenAPI promete cierre sin excepción, la expectativa preferida es `204`.

### D3. Intentar usar una sesión cerrada

Ejecutar cualquier tool con el objeto de sesión ya cerrado.

Respuesta esperada:

- Error `409 REALTIME_SESSION_CLOSED` si la sesión se retiene, o `404 RESOURCE_NOT_FOUND` si se elimina según la decisión anterior.
- El core no recibe la tool.

## Flujo E — Brief post-call

Enviar:

```http
POST /api/v1/calls/{callId}/brief
Content-Type: application/json

{
  "summary": "Atlas cotizó 8,500 MXN para pickup el 3 de septiembre.",
  "outcome": "QUOTE_OBTAINED",
  "mentions": ["1234", "8,500 MXN", "2026-09-03"],
  "objections": [],
  "actions": ["Quote registrada"],
  "nextSteps": ["Esperar selección de mercado"]
}
```

Respuesta esperada:

- HTTP `200`.
- `callId`, summary, outcome y arrays coinciden.
- `generatedAt` es un timestamp válido.
- Un único `CALL_BRIEF_SAVED`.
- El brief no cambia quote, mandato, selección o commitment.

## Criterio global

`PASS` requiere la matriz exacta, bloqueo antes del core para toda tool prohibida, argumentos validados, transcript determinista e idempotencia sin red externa. Una sesión Logistics capaz de modificar mandatos es un defecto crítico.
