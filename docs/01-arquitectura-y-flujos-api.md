# Arquitectura del sistema y flujos de API

## 1. Propósito

Este documento define la arquitectura de una demo funcional para el reto de agentes de voz de NextWave Hackathon 2026. Describe los componentes, sus responsabilidades y el endpoint que participa en cada paso del flujo operativo.

La fuente contractual de los endpoints es [`openapi.yaml`](../openapi.yaml). Si este documento y el archivo OpenAPI difieren, prevalece `openapi.yaml`.

## 2. Alcance de la demo

La demo debe poder:

- Crear una operación junto con su mandato inicial.
- Contactar al menos tres carriers mediante llamadas telefónicas reales.
- Negociar precio y fecha sin exceder el mandato.
- Guardar cotizaciones estructuradas.
- Seleccionar una oferta válida de forma auditable.
- Confirmar verbalmente un commitment.
- Enviar un recap escrito.
- Vincular el commitment con un intervalo y fragmento del transcript.
- Recibir una llamada con una incidencia.
- Evaluar un cambio y escalar a un humano si queda fuera del mandato.
- Confirmar pickup y delivery.

No se busca una arquitectura de producción. Se aceptan conscientemente:

- Una sola instancia de Node.js.
- SQLite como base de datos.
- Cola de trabajos en memoria.
- Eventos internos con `EventEmitter`.
- Pérdida de jobs pendientes cuando el proceso se reinicia.
- Autenticación simulada o ausente.
- Solo transcript de la llamada; la aplicación no solicita ni almacena grabaciones.
- Configuración manual de carriers y números telefónicos.

Quedan fuera del MVP:

- Redis, BullMQ, Kafka, RabbitMQ o NATS.
- PostgreSQL.
- Microservicios y Kubernetes.
- RAG, embeddings y base vectorial.
- LangGraph en el camino de voz.
- Un sistema completo de usuarios, roles y permisos.
- Alta disponibilidad, recuperación distribuida y observabilidad avanzada.

## 3. Principio central

> La IA conversa y propone; el backend valida y cambia el estado oficial.

OpenAI Realtime se usa para comprender voz, manejar interrupciones, negociar y elegir tools. Express y SQLite deciden si una acción está permitida y conservan su resultado.

La documentación oficial de OpenAI permite configurar una sesión Realtime con instrucciones y tools. También admite conexiones de audio en tiempo real; en esta arquitectura la integración elegida para la demo es un puente WebSocket desde Twilio Media Streams hacia OpenAI Realtime: <https://developers.openai.com/api/reference/python/resources/realtime/subresources/calls/methods/accept>.

## 4. Vista general

```text
Operador / Swagger UI
          │ HTTP
          ▼
┌────────────────────────────────────────────────────────────┐
│ Monolito Node.js + Express                                 │
│                                                            │
│  REST Controllers ── Services ── Domain Engines            │
│          │                │              │                  │
│          │                │              ├─ Mandate Engine  │
│          │                │              ├─ Market Engine   │
│          │                │              └─ Commitment FSM  │
│          │                │                                 │
│          │                ├─ In-memory Job Queue            │
│          │                ├─ EventEmitter                   │
│          │                └─ Realtime Session Gateway       │
│          │                                  │               │
│          ▼                                  ▼               │
│       SQLite                         OpenAI Realtime WS      │
└─────────────────────────────────────────────┬──────────────┘
                                              │ audio
                                      Twilio Media Stream
                                              │
                                             PSTN
                                              │
                                Carrier / dispatcher / driver
```

## 5. Componentes

### 5.1 Express API

Expone los endpoints REST, webhooks de Twilio y Swagger UI. Los controllers solamente validan la forma de la solicitud y llaman a los services.

Rutas auxiliares del preview:

| Ruta | Propósito |
|---|---|
| `GET /docs` | Swagger UI. |
| `GET /openapi.yaml` | Especificación OpenAPI sin procesar. |
| `GET /api/v1/health` | Verificación funcional del servidor. |

### 5.2 Operations Service

Gestiona la operación y sus transiciones:

```text
CREATED → SOURCING → BOOKED → PICKUP_PENDING
→ PICKED_UP → IN_TRANSIT → DELIVERED → COMPLETED
```

También contempla `NEEDS_RENEGOTIATION`, `ESCALATED`, `NEEDS_CARRIER` y `CANCELLED`.

### 5.3 Mandate Engine

Es código determinista. Evalúa:

- Precio total informado por el carrier.
- Moneda.
- Fecha única autorizada.

El mandato de la demo solo contiene `maxTotalPrice`, `currency`, `pickupDate` y `notes`. Las notas son contexto humano y no crean reglas deterministas adicionales.

Los mandatos son inmutables. Una modificación crea una fila con una versión superior.

### 5.4 Market Orchestrator y cola en memoria

El orchestrator crea una negociación por carrier y agrega jobs `CALL_CARRIER` a una cola implementada dentro del proceso Node.js.

Diseño suficiente para la demo:

```text
InMemoryJobQueue
├─ pendingJobs: Job[]
├─ activeCount: number
├─ concurrency: 3
├─ enqueue(job)
├─ processNext()
└─ retry con setTimeout, máximo 2 intentos
```

La cola no tiene un endpoint propio. `POST /operations/{operationId}/campaigns` agrega los jobs mediante una llamada interna al servicio. Un worker en el mismo proceso consume los jobs y llama directamente a `telephonyService.startOutboundCall()`; el monolito no se hace HTTP a sí mismo.

### 5.5 Market Engine

Descarta cotizaciones inválidas o expiradas y elige un ganador. Para la primera demo se recomienda la estrategia `LOWEST_VALID_TOTAL`:

1. Oferta dentro del mandato.
2. Cotización no expirada.
3. Menor precio total.
4. En empate, mayor `carrier.score`.
5. En nuevo empate, primera cotización recibida.

La explicación y las cotizaciones comparadas quedan en auditoría.

### 5.6 Commitment Engine

Máquina de estados:

```text
PROPOSED
→ VERBALLY_AGREED
→ MANDATE_VALIDATED
→ SUMMARY_PENDING
→ SUMMARY_SENT
→ VALID
→ IN_EXECUTION
→ FULFILLED
```

El commitment solamente llega a `VALID` después de que el proveedor de SMS o email acepta el recap. Para la demo no es necesario esperar confirmación de lectura.

### 5.7 Realtime Voice Session Gateway

Mantiene la correlación:

```text
callId ↔ operationId ↔ carrierId ↔ negotiationId
       ↔ mandateId ↔ agent ↔ mode
```

El gateway selecciona una de dos configuraciones lógicas:

- `OPERATIONS_AGENT`: lado interno, puede crear operaciones y mandatos.
- `LOGISTICS_AGENT`: lado externo, puede evaluar ofertas, registrar quotes, reportar incidencias y solicitar escalación. Nunca puede modificar el mandato.

Para simplificar la primera demo, el operador puede usar Swagger UI en lugar de llamar al Operations Agent. El Logistics Agent sí debe operar por telefonía real.

### 5.8 Twilio

Responsable de:

- Llamadas PSTN entrantes y salientes.
- Media Stream de audio.
- Estado de llamada.
- Conferencia para escalación humana.
- SMS de recap.

El canal de audio usa `wss://<host-publico>/ws/twilio-media/{callId}`. El `callId` en la ruta permite construir la lista estructural de tools antes de conectar OpenAI. OpenAPI documenta HTTP y no modela este WebSocket; por eso el canal aparece aquí y no como un path en `openapi.yaml`.

### 5.9 SQLite

Es la fuente de verdad operacional de la demo. La definición detallada está en [`02-base-de-datos-sqlite.md`](./02-base-de-datos-sqlite.md).

### 5.10 Audit Service

Cada cambio relevante inserta un evento en `audit_events`. Ejemplos:

- `OPERATION_CREATED`
- `MANDATE_CREATED`
- `CAMPAIGN_STARTED`
- `CALL_STARTED`
- `OFFER_EVALUATED`
- `QUOTE_RECORDED`
- `MARKET_WINNER_SELECTED`
- `COMMIT_AUTHORIZED`
- `VERBAL_AGREEMENT`
- `SUMMARY_SENT`
- `INCIDENT_REPORTED`
- `ESCALATION_REQUESTED`
- `PICKUP_CONFIRMED`
- `DELIVERY_CONFIRMED`

## 6. Convenciones de API

- Base URL: `http://127.0.0.1:3000/api/v1`.
- JSON para endpoints de negocio.
- `application/x-www-form-urlencoded` para webhooks de Twilio.
- Identificadores opacos con prefijos como `op_`, `call_`, `neg_` y `com_`.
- Fechas completas en ISO 8601.
- Horas locales como `HH:mm` dentro del mandato.
- Dinero como número decimal y moneda separada.
- `201` para recursos creados.
- `202` para trabajos agregados a la cola en memoria.
- `409` para una transición o acción incompatible con el estado actual.
- `422` para datos que no pueden evaluarse.

No hay autenticación real en el contrato de la demo. `OPENAI_API_KEY` y las credenciales de Twilio permanecen como variables del servidor y nunca se envían al navegador.

## 7. Catálogo resumido de endpoints

| Área | Endpoint | Uso |
|---|---|---|
| Operación | `POST /api/v1/operations` | Crear operación y mandato v1. |
| Operación | `GET /api/v1/operations/{operationId}` | Consultar detalle. |
| Operación | `GET /api/v1/operations/{operationId}/status` | Estado resumido. |
| Mandato | `GET /api/v1/operations/{operationId}/mandate` | Leer versión activa. |
| Mandato | `POST /api/v1/operations/{operationId}/mandates/versions` | Crear nueva versión. |
| Carrier | `GET /api/v1/carriers` | Listar candidatos. |
| Carrier | `POST /api/v1/carriers` | Crear carrier de prueba. |
| Campaña | `POST /api/v1/operations/{operationId}/campaigns` | Encolar llamadas a tres carriers. |
| Campaña | `GET /api/v1/operations/{operationId}/campaigns/{campaignId}` | Consultar progreso. |
| Llamada | `POST /api/v1/operations/{operationId}/calls/outbound` | Encolar una llamada manual. |
| Llamada | `GET /api/v1/calls/{callId}` | Consultar estado y transcript. |
| Realtime | `POST /api/v1/realtime/sessions` | Crear contexto de sesión. |
| Realtime | `DELETE /api/v1/realtime/sessions/{sessionId}` | Cerrar sesión. |
| Negociación | `POST /api/v1/negotiations/{negotiationId}/offers/evaluate` | Evaluar oferta. |
| Negociación | `POST /api/v1/negotiations/{negotiationId}/quotes` | Registrar quote final. |
| Mercado | `GET /api/v1/operations/{operationId}/quotes` | Comparación auditable. |
| Mercado | `POST /api/v1/operations/{operationId}/market/selection` | Seleccionar ganador. |
| Commitment | `POST /api/v1/operations/{operationId}/commitments/authorize` | Autorizar cierre. |
| Commitment | `POST /api/v1/commitments/{commitmentId}/verbal-agreement` | Acuerdo verbal. |
| Commitment | `POST /api/v1/commitments/{commitmentId}/evidence` | Adjuntar offsets y fragmento del transcript. |
| Commitment | `POST /api/v1/commitments/{commitmentId}/summary` | Encolar recap escrito. |
| Incidente | `POST /api/v1/operations/{operationId}/incidents` | Registrar incidencia. |
| Incidente | `POST /api/v1/incidents/{incidentId}/evaluate-change` | Evaluar cambio. |
| Escalación | `POST /api/v1/operations/{operationId}/escalations` | Solicitar humano. |
| Escalación | `POST /api/v1/escalations/{escalationId}/join-human` | Incorporar humano. |
| Ejecución | `POST /api/v1/operations/{operationId}/pickup/confirm` | Confirmar pickup. |
| Ejecución | `POST /api/v1/operations/{operationId}/delivery/confirm` | Confirmar entrega. |
| Post-call | `POST /api/v1/calls/{callId}/brief` | Guardar call brief. |
| Auditoría | `GET /api/v1/operations/{operationId}/audit-events` | Consultar timeline. |
| Twilio | `POST /api/v1/webhooks/twilio/voice` | Llamada entrante. |
| Twilio | `POST /api/v1/webhooks/twilio/status` | Estado de llamada. |

## 8. Flujo 1: preparar la demo

### Paso 1.1: registrar tres carriers

El operador de la demo llama tres veces:

```http
POST /api/v1/carriers
```

Cada solicitud crea nombre, dispatcher, teléfono, email y score. Alternativamente pueden insertarse como seeds al iniciar SQLite.

### Paso 1.2: comprobar el servidor

```http
GET /api/v1/health
```

Se espera `200` con `{ "status": "ok" }`.

## 9. Flujo 2: crear operación y mandato

### Paso 2.1: expresar la necesidad

El operador dice o captura:

```text
Mover TCLU1234567 de Manzanillo a Guadalajara el jueves,
máximo $9,000 MXN.
```

Si existe Operations Agent, este interpreta la frase. Si no, el presentador llena el request desde Swagger.

### Paso 2.2: crear la operación y el mandato v1

```http
POST /api/v1/operations
```

El body contiene los datos de la operación y un objeto `mandate` con precio máximo, moneda, fecha única y notas. En una sola transacción el backend:

1. Inserta `operations` con estado `CREATED`.
2. Inserta `mandates` versión `1` y estado `ACTIVE`.
3. Agrega `OPERATION_CREATED` y `MANDATE_CREATED` a auditoría usando el nuevo `mandateId`.

### Paso 2.3: verificar lo interpretado

```http
GET /api/v1/operations/{operationId}/status
GET /api/v1/operations/{operationId}/mandate
```

El operador revisa los datos antes de iniciar llamadas.

## 10. Flujo 3: iniciar sourcing y llamadas salientes

### Paso 3.1: consultar carriers

```http
GET /api/v1/carriers
```

La interfaz selecciona tres `carrierId`.

### Paso 3.2: iniciar campaña

```http
POST /api/v1/operations/{operationId}/campaigns
```

El request contiene al menos tres carriers. El controller llama `marketOrchestrator.startCampaign()`.

Acciones internas sin endpoint adicional:

1. Inserta `campaigns`.
2. Inserta una `negotiation` por carrier.
3. Inserta una `call` con estado `QUEUED` por negociación.
4. Agrega tres jobs `CALL_CARRIER` a `InMemoryJobQueue`.
5. Cambia la operación a `SOURCING`.
6. Devuelve `202 Accepted`.

### Paso 3.3: ejecutar cada job

El worker llama directamente:

```text
telephonyService.startOutboundCall(callId)
```

No se llama un endpoint interno. Twilio crea la llamada PSTN y usa:

```http
POST /api/v1/webhooks/twilio/status
```

para reportar `ringing`, `in-progress`, `completed` o errores.

Para una llamada individual de prueba puede usarse:

```http
POST /api/v1/operations/{operationId}/calls/outbound
```

### Paso 3.4: crear la sesión de voz

Cuando comienza el audio, el gateway llama internamente `realtimeSessionService.create()`. Para probar la misma operación por HTTP existe:

```http
POST /api/v1/realtime/sessions
```

El backend devuelve agente, modo y tools permitidas. En modo `QUOTE` no incluye ninguna tool de commitment o modificación del mandato.

### Paso 3.5: transportar audio

Twilio se conecta a:

```text
wss://<host-publico>/ws/twilio-media/{callId}
```

El gateway convierte y reenvía audio hacia la conexión WebSocket de OpenAI Realtime. Esto no usa un endpoint REST del contrato.

## 11. Flujo 4: negociar y registrar quotes

### Paso 4.1: consultar autoridad actual

Antes de negociar, el Logistics Agent usa:

```http
GET /api/v1/operations/{operationId}/mandate
```

### Paso 4.2: escuchar una oferta

Ejemplo del carrier:

```text
$8,500 MXN para recoger durante el jueves.
```

### Paso 4.3: evaluar la oferta

La tool del agente llama:

```http
POST /api/v1/negotiations/{negotiationId}/offers/evaluate
```

El Mandate Engine compara `totalPrice`, `currency` y `pickupDate` contra el mandato vigente. Devuelve `allowed`, código, razones y el `mandateId` exacto usado. GPT utiliza el resultado para aceptar provisionalmente o contraofertar, pero no puede alterar el resultado.

### Paso 4.4: registrar la quote final

Cuando el carrier da su mejor oferta:

```http
POST /api/v1/negotiations/{negotiationId}/quotes
```

La quote guarda precio total, moneda, fecha, notas, vigencia, llamada y una FK `mandateId` al mandato exacto usado. “Registrar quote” no equivale a reservar.

### Paso 4.5: finalizar llamada

Twilio reporta el fin mediante:

```http
POST /api/v1/webhooks/twilio/status
```

El gateway cierra su contexto mediante el service interno o, para una prueba HTTP:

```http
DELETE /api/v1/realtime/sessions/{sessionId}
```

### Paso 4.6: seguir la campaña

```http
GET /api/v1/operations/{operationId}/campaigns/{campaignId}
GET /api/v1/operations/{operationId}/quotes
```

La campaña queda `READY_TO_SELECT` cuando concluyen las tres negociaciones o cuando cada carrier tiene un resultado terminal.

## 12. Flujo 5: seleccionar y comprometer

### Paso 5.1: seleccionar ganador

```http
POST /api/v1/operations/{operationId}/market/selection
```

El Market Engine evalúa quotes dentro de una transacción de lectura y devuelve el ganador, la estrategia y la explicación auditable.

### Paso 5.2: autorizar el único cierre

```http
POST /api/v1/operations/{operationId}/commitments/authorize
```

El backend revalida:

- Quote ganadora.
- Vigencia.
- Mandato activo.
- Estado de operación.
- Ausencia de otro commitment activo.

Después crea `PROPOSED`. La restricción de SQLite impide dos commitments activos.

### Paso 5.3: llamar al ganador en modo COMMIT

```http
POST /api/v1/operations/{operationId}/calls/outbound
```

El purpose es `COMMIT`. La cola ejecuta el mismo flujo de Twilio y Realtime, pero la sesión ahora expone las tools de acuerdo verbal.

### Paso 5.4: registrar acuerdo verbal

Después de que el carrier diga claramente “sí, confirmado”:

```http
POST /api/v1/commitments/{commitmentId}/verbal-agreement
```

El backend vuelve a validar el mandato y pasa por `VERBALLY_AGREED` y `MANDATE_VALIDATED`.

### Paso 5.5: asociar evidencia del transcript

Cuando el gateway ya consolidó el transcript:

```http
POST /api/v1/commitments/{commitmentId}/evidence
```

Guarda `callId`, `startMs`, `endMs` y `transcriptExcerpt` de la confirmación. No se guarda una grabación completa.

Esta decisión reduce almacenamiento y complejidad, pero también reduce el cumplimiento estricto del reto: un transcript con offsets no permite reproducir el audio original. Si los jueces exigen evidencia audible, deberá conservarse al menos la grabación remota de Twilio o un clip corto de confirmación.

### Paso 5.6: enviar recap

```http
POST /api/v1/commitments/{commitmentId}/summary
```

El endpoint cambia a `SUMMARY_PENDING` y agrega `SEND_SUMMARY` a la cola. El worker llama a Twilio SMS o al proveedor de email. Cuando el proveedor acepta el mensaje:

```text
SUMMARY_PENDING → SUMMARY_SENT → VALID
operation.status → BOOKED
```

Si el envío falla, el job se reintenta hasta dos veces y el commitment no llega a `VALID`.

### Paso 5.7: mostrar el resultado

```http
GET /api/v1/operations/{operationId}/commitments
GET /api/v1/operations/{operationId}/audit-events
```

## 13. Flujo 6: llamada entrante e incidencia

### Paso 6.1: Twilio recibe la llamada

Twilio llama:

```http
POST /api/v1/webhooks/twilio/voice
```

El backend busca el carrier por `From`. Si hay varias operaciones activas, usa la de `updatedAt` más reciente; el agente confirma contenedor y ruta al inicio de la conversación antes de ejecutar tools. Después devuelve TwiML que conecta el Media Stream.

### Paso 6.2: crear sesión INCIDENT

El gateway crea el contexto internamente. Su equivalente de prueba es:

```http
POST /api/v1/realtime/sessions
```

con `actorType=DRIVER` y `mode=INCIDENT`.

### Paso 6.3: registrar incidencia

Cuando el conductor informa una avería:

```http
POST /api/v1/operations/{operationId}/incidents
```

El campo `type` es una etiqueta libre y amplia, por ejemplo `GENERAL`. No existe un enum de averías, retrasos o cancelaciones y el backend no toma decisiones usando ese texto. La evaluación usa únicamente la descripción y el cambio propuesto.

### Paso 6.4: evaluar el cambio propuesto

```http
POST /api/v1/incidents/{incidentId}/evaluate-change
```

Si el cambio está dentro de la tolerancia, el backend actualiza la incidencia a `ALLOWED_CHANGE` y la conversación continúa. Si queda fuera, devuelve un código como `DATE_OUTSIDE_MANDATE` y marca `NEEDS_ESCALATION`.

## 14. Flujo 7: escalación y nueva versión del mandato

### Paso 7.1: solicitar escalación

```http
POST /api/v1/operations/{operationId}/escalations
```

El body contiene llamada activa, motivo y resumen de contexto.

### Paso 7.2: incorporar al humano

```http
POST /api/v1/escalations/{escalationId}/join-human
```

El endpoint agrega `JOIN_HUMAN` a la cola. El worker llama la API de conferencia de Twilio y añade el teléfono interno sin colgar al carrier.

### Paso 7.3: autorizar una excepción

Si el operador acepta una nueva fecha:

```http
POST /api/v1/operations/{operationId}/mandates/versions
```

Se crea, por ejemplo, `mandate v2`; `v1` pasa a `SUPERSEDED`.

### Paso 7.4: reconsultar autoridad

El Logistics Agent debe llamar nuevamente:

```http
GET /api/v1/operations/{operationId}/mandate
```

Solo después puede aceptar el cambio. No se confía en que el modelo recuerde la autorización verbal.

## 15. Flujo 8: pickup, tránsito y delivery

### Paso 8.1: confirmar pickup

Cuando el conductor informa “ya recogí el contenedor”:

```http
POST /api/v1/operations/{operationId}/pickup/confirm
```

El backend valida que exista un commitment válido y avanza:

```text
BOOKED/PICKUP_PENDING → PICKED_UP → IN_TRANSIT
commitment → IN_EXECUTION
```

### Paso 8.2: confirmar entrega

Cuando informa “ya entregamos”:

```http
POST /api/v1/operations/{operationId}/delivery/confirm
```

El backend avanza:

```text
IN_TRANSIT → DELIVERED → COMPLETED
commitment → FULFILLED
```

## 16. Flujo 9: post-call y auditoría

### Paso 9.1: consolidar transcript y guardar call brief

El analizador post-call opcional recibe transcript, eventos de tools y estado final. Después llama:

```http
POST /api/v1/calls/{callId}/brief
```

El brief puede resumir, pero no puede modificar mandato, quote, ganador o commitment.

La tabla `calls` conserva el transcript como texto. No almacena URL, SID, duración ni contenido de grabación.

### Paso 9.2: consultar trazabilidad

```http
GET /api/v1/calls/{callId}
GET /api/v1/operations/{operationId}/audit-events
```

La presentación debe mostrar quote comparison, commitment, recap y el fragmento temporal del transcript desde estas lecturas.

## 17. Tools expuestas a cada agente

### Operations Agent

| Tool lógica | Endpoint |
|---|---|
| `create_operation` | `POST /api/v1/operations` (incluye mandato v1) |
| `get_operation_status` | `GET /api/v1/operations/{operationId}/status` |
| `update_mandate` | `POST /api/v1/operations/{operationId}/mandates/versions` |
| `list_carriers` | `GET /api/v1/carriers` |
| `start_campaign` | `POST /api/v1/operations/{operationId}/campaigns` |
| `get_quotes` | `GET /api/v1/operations/{operationId}/quotes` |
| `get_commitments` | `GET /api/v1/operations/{operationId}/commitments` |
| `cancel_operation` | `POST /api/v1/operations/{operationId}/cancel` |

### Logistics Agent

| Tool lógica | Endpoint |
|---|---|
| `get_mandate` | `GET /api/v1/operations/{operationId}/mandate` |
| `evaluate_offer` | `POST /api/v1/negotiations/{negotiationId}/offers/evaluate` |
| `record_quote` | `POST /api/v1/negotiations/{negotiationId}/quotes` |
| `record_verbal_agreement` | `POST /api/v1/commitments/{commitmentId}/verbal-agreement` |
| `attach_evidence` | `POST /api/v1/commitments/{commitmentId}/evidence` |
| `send_summary` | `POST /api/v1/commitments/{commitmentId}/summary` |
| `report_incident` | `POST /api/v1/operations/{operationId}/incidents` |
| `evaluate_change` | `POST /api/v1/incidents/{incidentId}/evaluate-change` |
| `request_escalation` | `POST /api/v1/operations/{operationId}/escalations` |
| `confirm_pickup` | `POST /api/v1/operations/{operationId}/pickup/confirm` |
| `confirm_delivery` | `POST /api/v1/operations/{operationId}/delivery/confirm` |

El gateway no envía al Logistics Agent ninguna tool para crear o modificar mandatos, seleccionar ganador o autorizar un commitment.

## 18. Errores y comportamiento esperado

| Situación | Respuesta |
|---|---|
| Oferta superior al mandato | `200` con `allowed=false`; no es un error HTTP porque la evaluación fue correcta. |
| Quote incompleta | `422`. |
| Intento de crear dos commitments activos | `409`. |
| Commitment con quote expirada | `409`. |
| Cambio fuera del mandato | `200` con `allowed=false`; después se escala. |
| Repetición del mismo webhook de Twilio | Se procesa idempotentemente usando `CallSid`. |
| Reinicio del proceso | Los jobs en memoria se pierden; los datos ya escritos en SQLite permanecen. |

## 19. Estructura sugerida del código futuro

```text
src/
├── server.js
├── app.js
├── database/
│   ├── sqlite.js
│   └── migrations/
├── operations/
├── mandates/
├── carriers/
├── campaigns/
├── negotiations/
├── market/
├── commitments/
├── calls/
├── incidents/
├── escalations/
├── audit/
├── realtime/
├── telephony/
├── agents/
│   ├── operations-agent.js
│   └── logistics-agent.js
├── queue/
│   └── in-memory-job-queue.js
└── webhooks/
```

Esta estructura sigue siendo un solo proceso Express. Las carpetas separan responsabilidades, no despliegues.

## 20. Criterio de finalización de la demo

La demo se considera completa cuando puede mostrar, en una sola operación:

1. Mandato creado y visible.
2. Tres llamadas PSTN iniciadas.
3. Tres resultados de negociación.
4. Comparación de quotes.
5. Un solo ganador autorizado.
6. Acuerdo verbal y evidencia mediante fragmento temporal del transcript.
7. Recap escrito aceptado por el proveedor.
8. Commitment `VALID`.
9. Llamada entrante con incidencia.
10. Cambio fuera del mandato y escalación humana en vivo.
11. Nueva versión de mandato.
12. Pickup y delivery confirmados.
13. Timeline de auditoría y call briefs visibles.
