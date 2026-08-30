# TEST-BE-01 — Sourcing, selección y commitment sin telefonía

## Objetivo

Probar el flujo feliz completo desde la creación de una operación hasta un único commitment `VALID`, usando tres carriers simulados, llamadas falsas, conversación textual estructurada y un recap aceptado por un proveedor falso.

## Precondiciones

- `TEST-BE-00` terminó en `PASS`.
- La base está vacía y el reloj está fijado en `T0`.
- Están inyectados `FakeTelephonyGateway` y `FakeSummarySender`.
- `VoiceCorePort.executeVoiceTool()` delega a services reales del backend; no devuelve éxitos prefabricados.
- No existe ninguna conexión externa.

## Variables capturadas

El orquestador debe conservar:

```text
carrierAId, carrierBId, carrierCId
operationId, mandateV1Id, campaignId
negotiationAId, negotiationBId, negotiationCId
quoteCallAId, quoteCallBId, quoteCallCId
quoteAId, quoteBId, quoteCId
commitmentId, commitCallId, commitSessionId
```

## Flujo

### 1. Registrar tres carriers de prueba

Enviar tres veces `POST /api/v1/carriers`:

```json
[
  {
    "name": "Transportes Atlas E2E-<runId>",
    "dispatcherName": "Laura",
    "phone": "+525500000001",
    "email": "atlas-<runId>@example.test",
    "score": 90
  },
  {
    "name": "Transportes Norte E2E-<runId>",
    "dispatcherName": "Bruno",
    "phone": "+525500000002",
    "email": "norte-<runId>@example.test",
    "score": 85
  },
  {
    "name": "Transportes Pacífico E2E-<runId>",
    "dispatcherName": "Carla",
    "phone": "+525500000003",
    "email": "pacifico-<runId>@example.test",
    "score": 80
  }
]
```

Respuesta esperada para cada solicitud:

- HTTP `201`.
- `id` no vacío y distinto para cada carrier.
- Nombre, dispatcher, teléfono y score coinciden con la entrada.
- `active` es `true`.
- Ningún gateway externo fue invocado.

### 2. Crear operación y mandato v1

Enviar `POST /api/v1/operations`:

```json
{
  "customerName": "Textiles Pacífico E2E-<runId>",
  "containerNumber": "TCLU1234567",
  "origin": "Puerto de Manzanillo",
  "destination": "Guadalajara",
  "service": "DRAYAGE",
  "mandate": {
    "maxTotalPrice": 9000,
    "currency": "MXN",
    "pickupDate": "2026-09-03",
    "notes": "No aceptar cambios sin reevaluar el mandato."
  }
}
```

Respuesta esperada:

- HTTP `201`.
- Operación con `status: "CREATED"`, `selectedCarrierId: null` y los datos exactos de ruta.
- Mandato relacionado con `version: 1`, `status: "ACTIVE"`, moneda `MXN` y valor equivalente a `900000` centavos.
- Se capturan `operationId` y `mandateV1Id`.
- En la misma transacción existen exactamente un `OPERATION_CREATED` y un `MANDATE_CREATED` referidos a esos IDs.

### 3. Verificar la fuente de autoridad

Consultar:

```http
GET /api/v1/operations/{operationId}
GET /api/v1/operations/{operationId}/status
GET /api/v1/operations/{operationId}/mandate
```

Respuesta esperada:

- Las tres respuestas son HTTP `200`.
- El mandato activo es exactamente `mandateV1Id`.
- Aún no hay campaña, llamadas, quotes, carrier seleccionado ni commitment.
- Ninguna lectura cambia `updatedAt` ni agrega auditoría.

### 4. Iniciar una campaña con tres carriers explícitos

Enviar `POST /api/v1/operations/{operationId}/campaigns`:

```json
{
  "carrierIds": ["<carrierAId>", "<carrierBId>", "<carrierCId>"],
  "maxParallelCalls": 3
}
```

Respuesta contractual esperada:

- HTTP `202`.
- Campaña relacionada con la operación, `requestedCarriers: 3` y estado `CALLING` después de entregar las tres negociaciones al `CallScheduler`.
- Se crean exactamente tres negociaciones, una por carrier, sin duplicados.
- La operación cambia a `SOURCING`.
- Se crean o encolan exactamente tres calls `OUTBOUND/QUOTE/QUEUED`.
- Existe un solo `CAMPAIGN_STARTED` y un `CAMPAIGN_CALLS_ENQUEUED`, ambos con `requestedCarriers: 3` y los IDs correctos.

Si la ruta acepta solamente `requestedCarriers` y elige carriers aleatorios, existe drift respecto de OpenAPI y el paso es `FAIL`; la prueba no debe adaptarse silenciosamente.

### 5. Despachar las llamadas falsas

Esperar `queue.onIdle()` y consultar las tres calls.

Respuesta esperada:

- El pico de concurrencia no supera `3`.
- `FakeTelephonyGateway` recibió exactamente tres invocaciones, una por `callId`.
- Cada call conserva operación, carrier y negociación correctos.
- Cada call tiene un `providerCallId` falso distinto y sigue un ciclo válido.
- Existen tres `CALL_QUEUED` y tres `CALL_DISPATCHED` sin duplicados.
- No hubo DNS, HTTP, WebSocket, Twilio ni OpenAI externos.

### 6. Simular el inicio de las tres conversaciones

Para cada call, aplicar en orden los estados de proveedor `ringing` e `in-progress`, y crear una sesión `QUOTE` con actor `CARRIER`.

Respuesta esperada por call:

- Las transiciones terminan en `RINGING` y después `IN_PROGRESS`.
- `startedAt` se fija una sola vez al entrar a `IN_PROGRESS`.
- La sesión devuelve `agent: "LOGISTICS_AGENT"`, `mode: "QUOTE"`, `mandateId: mandateV1Id` y `status: "ACTIVE"`.
- `allowedTools` incluye `getActiveMandate`, `evaluateOffer`, `recordQuote`, `reportNoAnswer` y `saveCallBrief`.
- `allowedTools` no incluye `createMandate`, `recordVerbalAgreement`, `confirmPickup` ni `confirmDelivery`.

### 7. Evaluar las ofertas simuladas

Cada simulador entrega su oferta; el orquestador llama `POST /api/v1/negotiations/{negotiationId}/offers/evaluate` o la misma operación mediante `VoiceCorePort`.

| Carrier | Entrada | Respuesta esperada |
|---|---|---|
| A | `8500`, `MXN`, `2026-09-03` | HTTP `200`, `allowed: true`, `code: "ALLOWED"`, `reasons: []`, `mandateId: mandateV1Id`. |
| B | `9300`, `MXN`, `2026-09-03` | HTTP `200`, `allowed: false`, `code: "PRICE_EXCEEDS_MANDATE"`, al menos una razón con `9300` y `9000`, mismo mandato. |
| C | `8800`, `MXN`, `2026-09-03` | HTTP `200`, `allowed: true`, `code: "ALLOWED"`, `reasons: []`, mismo mandato. |

La evaluación no persiste una quote, no cambia el mandato y no promete una reservación.

### 8. Registrar las tres quotes finales

Enviar `POST /api/v1/negotiations/{negotiationId}/quotes` con cada oferta, `validUntil: "2026-09-01T14:00:00.000Z"`, el dispatcher y su `callId`.

Respuesta esperada:

- Las tres solicitudes devuelven HTTP `201`.
- A: `valid: true`, precio equivalente a `850000` centavos.
- B: `valid: false`, precio equivalente a `930000` centavos y `invalidReason` no vacío.
- C: `valid: true`, precio equivalente a `880000` centavos.
- Todas referencian `mandateV1Id`, la negociación, carrier y call correctos.
- Cada negociación cambia a `QUOTED`.
- Existen exactamente tres eventos `QUOTE_RECORDED`; la quote inválida también queda auditada.

### 9. Cerrar las conversaciones y guardar briefs

Agregar segmentos textuales mediante `RealtimeService`, cerrar cada sesión, aplicar estado de call `COMPLETED` y guardar un brief con `outcome: "QUOTE_OBTAINED"`.

Respuesta esperada:

- Cada transcript contiene la oferta humana y la respuesta del agente con speaker y offset.
- `realtimeSessionId` queda en `null` al cerrar.
- Cada call termina `COMPLETED` con `endedAt` no nulo.
- Cada brief responde HTTP `200`, conserva su `callId` y genera un `CALL_BRIEF_SAVED`.
- Cerrar de nuevo una sesión no duplica transcript ni auditoría.

### 10. Declarar la campaña lista para selección

Consultar campaña y quotes:

```http
GET /api/v1/operations/{operationId}/campaigns/{campaignId}
GET /api/v1/operations/{operationId}/quotes
```

Respuesta esperada:

- HTTP `200` en ambas lecturas.
- Campaña `READY_TO_SELECT`, `completedNegotiations: 3`, `quoteCount: 3`.
- Se devuelven las tres quotes con su validez original.
- La operación continúa en `SOURCING` y no tiene carrier seleccionado antes del Market Engine.

### 11. Seleccionar al ganador determinísticamente

Enviar:

```http
POST /api/v1/operations/{operationId}/market/selection
Content-Type: application/json

{"strategy":"LOWEST_VALID_TOTAL"}
```

Respuesta esperada:

- HTTP `200` con un `MarketSelection`.
- `winningQuoteId: quoteAId` y `carrierId: carrierAId`.
- `strategy: "LOWEST_VALID_TOTAL"`.
- `comparedQuoteIds` contiene exactamente las quotes elegibles de A y C; la quote inválida B aparece en `excludedQuotes` dentro de la auditoría.
- La explicación indica que A es la oferta vigente de menor total dentro del mandato.
- Existe un solo `MARKET_WINNER_SELECTED`; B y C nunca quedan autorizados.
- La operación conserva `SOURCING` durante autorización/cierre y solo llegará a `BOOKED` cuando el commitment sea `VALID`.

### 12. Autorizar un único commitment

Enviar:

```http
POST /api/v1/operations/{operationId}/commitments/authorize
Content-Type: application/json

{"winningQuoteId":"<quoteAId>"}
```

Respuesta esperada:

- HTTP `201`.
- Commitment `PROPOSED` relacionado con A, `quoteAId`, `mandateV1Id`, `8500 MXN` y fecha `2026-09-03`.
- Evidencia y recap todavía son nulos.
- Existe un solo evento `COMMIT_AUTHORIZED`.
- No existe ningún commitment para B o C.

### 13. Simular la llamada de compromiso

Encolar una call outbound con `carrierAId`, propósito `COMMIT`; esperar la cola, pasarla a `IN_PROGRESS` y crear sesión `COMMIT`.

Respuesta esperada:

- HTTP `202` al encolar y una sola llamada falsa adicional.
- La sesión usa `LOGISTICS_AGENT`.
- Sus tools incluyen `getAuthorizedCommitment`, `recordVerbalAgreement`, `attachCommitmentEvidence`, `enqueueCommitmentSummary` y `saveCallBrief`.
- No incluye `recordQuote`, `createMandate`, `confirmPickup` ni `confirmDelivery`.

Agregar al transcript:

```text
[10.0s] AGENT: Confirmo Manzanillo a Guadalajara, pickup el 3 de septiembre, total 8,500 MXN. ¿Lo acepta?
[15.0s] HUMAN: Sí, confirmamos el servicio por 8,500 MXN para el 3 de septiembre.
```

La respuesta humana debe ser explícita; frases como “suena bien” no son equivalentes.

### 14. Registrar acuerdo y evidencia

Enviar `POST /api/v1/commitments/{commitmentId}/verbal-agreement`:

```json
{
  "callId": "<commitCallId>",
  "confirmedBy": "Laura, dispatcher de Transportes Atlas",
  "exactTerms": "8,500 MXN; pickup 2026-09-03; Puerto de Manzanillo a Guadalajara."
}
```

Después enviar `POST /api/v1/commitments/{commitmentId}/evidence`:

```json
{
  "callId": "<commitCallId>",
  "startMs": 15000,
  "endMs": 21000,
  "transcriptExcerpt": "Sí, confirmamos el servicio por 8,500 MXN para el 3 de septiembre."
}
```

Respuesta esperada:

- Ambos endpoints responden HTTP `200`.
- El flujo registra `VERBALLY_AGREED` y termina este tramo en `MANDATE_VALIDATED`.
- El backend revalida el mandato activo; no confía en la decisión del agente.
- Los offsets cumplen `0 <= startMs < endMs` y pertenecen a la call de compromiso.
- El extracto existe en el transcript consolidado y queda persistido sin almacenar audio.
- Auditoría: acuerdo verbal, revalidación del mandato y evidencia adjunta, una vez cada uno.

### 15. Enviar recap mediante el proveedor falso

Enviar `POST /api/v1/commitments/{commitmentId}/summary`:

```json
{
  "channel": "SMS",
  "recipient": "+525500000001",
  "message": "Confirmamos TCLU1234567: Manzanillo a Guadalajara, pickup 3-sep-2026, total 8,500 MXN."
}
```

Respuesta esperada:

- HTTP `202` y estado inmediato `SUMMARY_PENDING`.
- Se encola exactamente un job de recap.
- `FakeSummarySender` recibe exactamente un mensaje con contenedor, ruta, fecha, moneda y precio correctos.
- Tras `queue.onIdle()`, el commitment pasa por `SUMMARY_SENT` y termina `VALID`.
- `summaryProviderId` es `SM_FAKE_<commitmentId>` y `summarySentAt` coincide con el fake.
- La operación queda `BOOKED` con `selectedCarrierId: carrierAId`.
- La campaña termina `COMPLETED`.

### 16. Verificación final de consistencia

Consultar operación, quotes, commitments, calls y auditoría.

Debe cumplirse todo lo siguiente:

- una operación, un mandato activo, una campaña y tres negociaciones;
- cuatro calls outbound: tres `QUOTE` y una `COMMIT`;
- tres quotes: dos válidas y una inválida;
- una selección y un solo commitment activo;
- ganador A por `8500 MXN`, sin mutaciones en B o C;
- commitment `VALID` únicamente después del recap aceptado;
- no existen eventos duplicados para una misma transición;
- ningún secreto, grabación o audio fue persistido;
- invocaciones externas observadas: cero.

## Criterio global

`PASS` exige que los 16 pasos pasen. Un endpoint no montado, `VoiceCorePort` con `503`, una ruta alternativa no contractual o una transición colapsada que omita estados/auditoría produce `FAIL` o `BLOCKED`, con la primera diferencia documentada.
