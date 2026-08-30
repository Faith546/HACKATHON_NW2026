# TEST-BE-03 — Guardrails, concurrencia e idempotencia

## Objetivo

Demostrar que el backend falla cerrado: el modelo no puede exceder el mandato, seleccionar una quote inválida, crear dos commitments activos, repetir efectos externos ni hacer regresar una llamada desde un estado terminal.

## Precondiciones

- `TEST-BE-00` está en `PASS`.
- Se usan reloj, IDs, SQLite y gateways controlados.
- Cada escenario inicia con su propio fixture; un fallo no contamina al siguiente.
- Las solicitudes concurrentes usan barrera de inicio y conexiones compatibles con SQLite.

## G1 — Validación de campaña

| Acción | Respuesta esperada | Efecto esperado |
|---|---|---|
| Iniciar campaña con 0, 1 o 2 `carrierIds`. | HTTP `422`, error de validación. | No hay campaña, negociación, call ni cambio de operación. |
| Repetir un carrier en `carrierIds`. | HTTP `422`. | No se crean duplicados. |
| Incluir un carrier inexistente o inactivo. | HTTP `409` con código estable de carrier no disponible. | Transacción revertida por completo. |
| Iniciar otra campaña mientras la operación ya está `SOURCING`. | HTTP `409 CAMPAIGN_NOT_ALLOWED`. | La campaña original permanece única. |

La selección aleatoria de carriers a partir de `requestedCarriers` no satisface este contrato: el caller debe poder demostrar cuáles tres carriers autorizó.

## G2 — El Mandate Engine decide, no el agente

Fixture: mandato activo de `9000 MXN`, pickup máximo `2026-09-03`.

| Oferta | HTTP | Respuesta semántica obligatoria |
|---|---:|---|
| `8500 MXN`, `2026-09-03` | `200` | `allowed: true`, `code: ALLOWED`, sin razones. |
| `9000 MXN`, `2026-09-03` | `200` | Permitida; el límite es inclusivo. |
| `9000.01 MXN`, `2026-09-03` | `200` | `allowed: false`, `code: PRICE_EXCEEDS_MANDATE`. |
| `8500 USD`, `2026-09-03` | `200` | `allowed: false`, código contractual `CURRENCY_MISMATCH` y razón con `USD`/`MXN`. Si OpenAPI aún no enumera el código, registrar drift y corregir el contrato antes de aprobar. |
| `8500 MXN`, `2026-09-04` | `200` | `allowed: false`, `code: DATE_OUTSIDE_MANDATE`. |
| Precio cero, negativo, `NaN` o campo faltante | `422` | Error de validación; no se ejecuta evaluación de negocio. |

En todos los casos:

- `mandateId` debe ser el activo al momento de evaluar;
- la evaluación por sí sola no crea quote;
- el agente no puede sustituir `allowed` ni el código;
- no se modifica el mandato.

## G3 — Quotes y selección

### G3.1 Registrar una quote inválida

Registrar la oferta de `9300 MXN`.

Respuesta esperada:

- HTTP `201` porque el hecho fue registrado correctamente.
- `valid: false`, `invalidReason` no vacío y referencia al mandato usado.
- La negociación queda terminal `QUOTED`.
- `QUOTE_RECORDED` registra que fue inválida.

### G3.2 Intentar seleccionarla

Ejecutar Market Selection cuando solo existe esa quote.

Respuesta esperada:

- HTTP `409 NO_ELIGIBLE_QUOTES`.
- No hay carrier seleccionado, commitment ni `MARKET_WINNER_SELECTED`.

### G3.3 Quote expirada

Crear una quote válida con `validUntil < T0` y otra vigente. Ejecutar estrategia `LOWEST_VALID_TOTAL`.

Respuesta esperada:

- La expirada nunca gana aunque sea más barata.
- Gana la quote válida vigente.
- La explicación y auditoría mencionan el descarte por expiración.

### G3.4 Quote ligada a un mandato superado

Registrar quote bajo mandato v1, crear mandato v2 y después intentar seleccionarla o autorizarla.

Respuesta esperada:

- HTTP `409`, `QUOTE_MANDATE_STALE` o código contractual equivalente.
- El backend no actualiza silenciosamente el `mandateId` de la quote.
- No se crea commitment.

### G3.5 Desempate

Crear dos quotes válidas, vigentes y con el mismo total. La de mayor `carrier.score` debe ganar. Si precio y score empatan, gana la primera recibida. Repetir la selección debe producir el mismo ganador y no un segundo evento.

## G4 — Un solo commitment autorizado

### G4.1 Quote no ganadora

Intentar autorizar una quote válida que no coincide con `winningQuoteId`.

Respuesta esperada:

- HTTP `409 QUOTE_NOT_SELECTED_WINNER`.
- Cero commitments y cero calls de compromiso.

### G4.2 Carrera concurrente

Lanzar simultáneamente dos solicitudes de autorización para el mismo ganador.

Respuesta esperada:

- Exactamente una responde `201` con `PROPOSED`.
- La otra responde `409 ACTIVE_COMMITMENT_EXISTS`.
- La base contiene un solo commitment activo y un solo `COMMIT_AUTHORIZED`.
- Ninguna respuesta es `500 SQLITE_CONSTRAINT` ni `SQLITE_BUSY`.

### G4.3 Acuerdo no explícito

El carrier simulado dice “suena bien, déjame revisarlo”. El agente de prueba no debe invocar `recordVerbalAgreement`.

Respuesta esperada:

- Commitment permanece `PROPOSED`.
- No existe evento de acuerdo ni resumen.

Si se fuerza una tool con `confirmedBy` o `exactTerms` vacíos, el backend devuelve `422` sin transición.

### G4.4 Evidencia inválida

Probar por separado:

| Entrada | Respuesta esperada |
|---|---|
| `startMs >= endMs` | `422` y ninguna evidencia persistida. |
| Call de otra operación/carrier | `409 CALL_COMMITMENT_MISMATCH`. |
| Rango fuera de la duración/transcript | `422 EVIDENCE_RANGE_OUTSIDE_CALL`. |
| Extracto que no aparece en transcript | `422 TRANSCRIPT_EXCERPT_MISMATCH`. |
| Segundo intento con evidencia diferente | `409 EVIDENCE_ALREADY_ATTACHED`. |

### G4.5 Fallo del recap

Configurar `FakeSummarySender` para fallar siempre.

Respuesta esperada:

- El job hace como máximo tres intentos totales: inicial más dos reintentos.
- Se invoca el sender tres veces, pero no se vuelve a registrar el acuerdo.
- Commitment no llega a `SUMMARY_SENT` ni `VALID`.
- Operación no llega a `BOOKED` por un envío ficticio.
- El fallo agotado queda auditable y no produce una respuesta `200` engañosa.

## G5 — Calls y webhooks idempotentes

Fixture: call con `providerCallId: CA_FAKE_001`.

### G5.1 Estados duplicados y fuera de orden

Aplicar esta secuencia:

```text
queued → ringing → ringing → in-progress → queued → completed → in-progress → completed
```

Respuesta esperada:

- Estado final `COMPLETED`.
- Solo se auditan transiciones efectivas: `QUEUED/RINGING/IN_PROGRESS/COMPLETED` según la convención de eventos.
- El segundo `ringing`, la regresión a `queued`, el regreso desde terminal y el segundo `completed` no cambian timestamps ni duplican eventos.
- `startedAt` y `endedAt` se fijan una sola vez.

### G5.2 Firma inválida

Enviar voice y status webhook sin firma o con firma incorrecta cuando la validación está activa.

Respuesta esperada:

- HTTP `403`, `code: "INVALID_TWILIO_SIGNATURE"`.
- No se crea ni modifica una call.
- No se devuelve TwiML para la solicitud inválida.

### G5.3 CallSid en conflicto

Asociar una call a `CA_FAKE_001` y después intentar asociarla a `CA_FAKE_002`.

Respuesta esperada:

- HTTP/service error `409 CALL_PROVIDER_ID_CONFLICT`.
- Se conserva `CA_FAKE_001`.

### G5.4 Retry sin redial

Hacer que el gateway acepte la call y que el primer guardado del provider ID falle de forma transitoria.

Respuesta esperada:

- El job se reintenta.
- El gateway se invoca una sola vez.
- El mismo provider ID se reutiliza.
- Después del retry existe un solo `CALL_DISPATCHED` efectivo.

### G5.5 Busy y no-answer

Crear dos calls y terminar una en `BUSY` y otra en `NO_ANSWER`.

Respuesta esperada:

- Ambos son estados terminales con `endedAt`.
- No hay sesión Realtime, transcript, quote ni compromiso inventado.
- La negociación correspondiente queda con resultado terminal auditable.
- Reintentos de webhook no redializan.

## G6 — Cola

Encolar cinco jobs bloqueables con `concurrency: 3`.

Respuesta esperada:

- Antes de liberar la barrera: tres activos y dos pendientes.
- El máximo observado nunca supera tres.
- Al liberar: los cinco terminan.
- Un job que siempre falla se ejecuta exactamente tres veces y llama una vez a `onExhausted`.

## Criterio global

`PASS` exige cero `5xx`, una única decisión por transición y ausencia total de side effects cuando una regla falla. Cualquier bypass del Mandate Engine o más de un commitment activo es severidad crítica.
