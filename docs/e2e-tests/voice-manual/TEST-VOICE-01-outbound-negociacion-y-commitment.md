# TEST-VOICE-01 — E2E completo: operación, market, commitment, inbound, incidencias, pickup, delivery y cierre

## Objetivo

Probar con PSTN y voz real el ciclo completo de una operación de drayage:

1. un operador autorizado llama al agente por teléfono y crea la operación y su mandato mediante voz;
2. inmediatamente después de crearla, el sistema inicia automáticamente la campaña y llama a tres carriers en paralelo, sin una segunda orden del operador;
3. el agente negocia sin salir del mandato y registra las cotizaciones;
4. al terminar las tres negociaciones, el backend selecciona automáticamente un único ganador auditable;
5. el backend autoriza automáticamente el commitment y llama al ganador, quien acepta inequívocamente y recibe el recap SMS;
6. después del booking, el carrier seleccionado puede llamar al número de Twilio;
7. el agente recibe y registra incidencias, y escala cuando corresponde;
8. el conductor confirma pickup por voz;
9. con la operación en tránsito, un operador autorizado llama al agente para solicitar el cierre; el agente exige confirmación inequívoca de la entrega y registra el delivery por voz;
10. la operación termina en `COMPLETED`, el commitment en `FULFILLED` y todas las calls usadas como evidencia quedan `COMPLETED` con `endedAt`.

Este documento es un runbook E2E autónomo. No permite reemplazar una conversación ni una transición automática por llamadas directas a endpoints. En particular, `POST /operations` no sustituye la creación por voz y los endpoints de campaña, selección, autorización y call `COMMIT` no sustituyen la orquestación automática. Después de confirmar la creación, el operador sólo vuelve a intervenir ante una incidencia que requiera decisión humana o para solicitar por llamada el cierre final de una operación en tránsito.

## Significado de “ended”

El contrato actual no contiene un estado de operación llamado `ENDED`. El cierre completo se demuestra con estos estados correlacionados:

| Entidad | Estado final obligatorio |
|---|---|
| Operación | `COMPLETED` |
| Commitment ganador | `FULFILLED` |
| Última call de delivery | `COMPLETED` y `endedAt` no nulo |
| Sesión Realtime de delivery | `CLOSED` o liberada de la call |
| Escalación usada durante el run | `RESOLVED` |
| Incidencia escalada | `RESOLVED` |

`DELIVERED` y `PICKED_UP` son transiciones conceptuales auditadas; las respuestas finales persisten `COMPLETED` e `IN_TRANSIT`, respectivamente.

## Alcance del caso

La ruta principal incluye una incidencia fuera del mandato que se rechaza y se resuelve conservando los términos originales. No se cambia el mandato ni se renegocia un commitment nuevo durante esta ruta, para que el run pueda continuar de forma determinista hasta delivery.

Una autorización humana para cambiar precio o pickup obliga a ejecutar un flujo completo de nueva versión de mandato, nueva negociación, nueva selección y nuevo commitment. No debe sobrescribirse el commitment original en silencio.

## Precondiciones

- `TEST-VOICE-00` está en `PASS` para el mismo commit y ambiente.
- Railway tiene una sola réplica y el deployment esperado está `ACTIVE/SUCCESS`.
- `GET /api/v1/health` responde HTTP `200`.
- `PUBLIC_BASE_URL`, `PUBLIC_WSS_URL`, SQLite, Twilio y OpenAI Realtime están configurados.
- El webhook de voz del número Twilio apunta a `POST /api/v1/webhooks/twilio/voice`.
- El operador que crea o cierra la operación llama desde un teléfono autorizado y distinguible de los teléfonos de carriers.
- La identidad del operador se valida antes de exponer `createOperation` o `confirmDelivery`; una persona no autorizada no puede crear, cerrar ni completar operaciones.
- Los tres teléfonos están consentidos, disponibles y almacenados en E.164.
- `HUMAN_ESCALATION_PHONE` apunta a un operador humano consentido y distinto del carrier.
- Los tres participantes tienen sus guiones y están listos antes de iniciar la campaña.
- Existen exactamente tres carriers activos elegibles para este run o la call de creación identifica inequívocamente los tres IDs que debe usar la campaña automática.
- La base está limpia o se usa un `containerNumber` único y no existe otra campaña activa para la operación.
- El operador tiene abiertos Swagger, Twilio Console, logs sanitizados y la auditoría de la operación.
- Las vigencias de las quotes todavía están en el futuro al momento del run.

## Compuerta conocida para llamadas de operador

La especificación de este caso exige calls PSTN reales del operador autenticado para dos acciones distintas:

1. crear una operación con semántica `OPERATIONS` y acceso a `createOperation`;
2. solicitar el cierre de una operación `IN_TRANSIT` con semántica `DELIVERY` y acceso a `confirmDelivery`.

La creación y el cierre deben ejecutarse una sola vez, después de confirmaciones verbales inequívocas, y cada call debe quedar vinculada al mismo `operationId`.

El registro de tools ya contiene `createOperation` y `confirmDelivery`, pero el runtime actual no expone una sesión inbound de operador que pueda usarlas: los actores Realtime actuales son carrier, dispatcher y driver, y la resolución inbound parte de un carrier conocido. Aunque `DELIVERY` existe, hoy se resuelve desde el teléfono del carrier seleccionado, no desde un operador interno autorizado; además, la auditoría de ejecución clasifica actualmente la confirmación como actor `DRIVER`, por lo que también debe distinguir `INTERNAL_OPERATOR` para satisfacer esta ruta.

Por lo tanto:

- este documento define la conducta E2E obligatoria que deben tener la creación y el cierre por voz;
- ejecutar `POST /api/v1/operations` desde Swagger es una ruta de preparación asistida, pero no satisface el paso de creación por voz;
- ejecutar `POST /api/v1/operations/{operationId}/delivery/confirm` desde Swagger no sustituye la confirmación dentro de la call de cierre;
- mientras la call de operador no pueda abrir sesiones autorizadas con `createOperation` y `confirmDelivery`, los flujos A y G y el resultado global estricto se reportan `BLOCKED`;
- la solución futura debe conservar transcript, brief, SID e identidad del operador en ambas calls, y resolver explícitamente la operación que se crea o cierra sin seleccionar silenciosamente otra orden.

## Compuerta conocida para orquestación automática

Después de `createOperation`, el comportamiento obligatorio es una sola cadena autónoma e idempotente:

```text
OPERATION_CREATED
→ START_CAMPAIGN
→ 3 × QUOTE_CALL
→ WAIT_ALL_NEGOTIATIONS_TERMINAL
→ LOWEST_VALID_TOTAL
→ AUTHORIZE_COMMITMENT
→ ENQUEUE_COMMIT_CALL
```

El operador no debe ejecutar manualmente:

```http
POST /api/v1/operations/{operationId}/campaigns
POST /api/v1/operations/{operationId}/market/selection
POST /api/v1/operations/{operationId}/commitments/authorize
POST /api/v1/operations/{operationId}/calls/outbound
```

El código actual expone esos cuatro endpoints, pero no tiene un orquestador que encadene automáticamente todas las transiciones. Actualmente la campaña sólo llega a `READY_TO_SELECT` cuando terminan las negociaciones; seleccionar, autorizar y encolar `COMMIT` requieren llamadas separadas.

Por lo tanto:

- los endpoints anteriores se permiten únicamente para diagnóstico y no cuentan como E2E autónomo;
- iniciar manualmente la campaña, seleccionar, autorizar o llamar al ganador etiqueta el run como `PASS ASSISTED`, nunca `PASS AUTONOMOUS`;
- el resultado global estricto permanece `BLOCKED` hasta que la cadena automática sea idempotente y se active por eventos persistidos;
- si no hay quotes elegibles, el orquestador debe detenerse en `NO_ELIGIBLE_QUOTES` y escalar; nunca debe autorizar una quote inválida;
- reintentos del proceso o webhooks no pueden crear otra campaña, otra selección, otro commitment ni otra call `COMMIT`.

## Compuerta conocida para incidencias autónomas

Una inbound del carrier ganador con operación `BOOKED` se resuelve actualmente como call `EXECUTION`. Ese modo permite `reportIncident`, `requestEscalation` y `confirmPickup`, pero no expone `evaluateIncidentChange`.

Por lo tanto:

- registrar la incidencia y solicitar escalación por voz sí forma parte de la ruta principal;
- inmediatamente después de `reportIncident`, el agente debe ejecutar automáticamente `evaluateIncidentChange` con el `incidentId` devuelto y los términos escuchados;
- `POST /incidents/{incidentId}/evaluate-change` queda como endpoint de diagnóstico y no sustituye la tool durante la conversación;
- mientras `EXECUTION` no exponga `evaluateIncidentChange`, el resultado estricto se reporta `BLOCKED`, no `PASS` autónomo;
- no se permite que el agente afirme que el cambio fue autorizado antes de obtener un resultado oficial.

Esta limitación no impide completar pickup y delivery después de rechazar el cambio y resolver la escalación con los términos originales.

## Datos canónicos

| Participante | Carrier | Resultado de sourcing |
|---|---|---|
| Laura | Transportes Atlas | `8500 MXN`, válido, ganador |
| Bruno | Transportes Norte | `9300 MXN`, inválido por precio |
| Carla | Transportes Pacífico | primer intento `500 USD`, oferta final `8800 MXN`, válida |

Mandato inicial:

```json
{
  "maxTotalPrice": 9000,
  "currency": "MXN",
  "pickupDate": "2026-09-03",
  "notes": "No aceptar cambios de precio o pickup sin reevaluar el mandato."
}
```

La fecha del mandato es la fecha de pickup en el puerto, no la fecha de entrega.

## Bitácora obligatoria del run

Antes de comenzar, crear una tabla y llenar cada ID conforme aparezca:

| Dato | Valor |
|---|---|
| `runId` | |
| `operatorCreationCallId` / `CA...` | |
| `operationId` | |
| `mandateV1Id` | |
| `carrierAId` | |
| `carrierBId` | |
| `carrierCId` | |
| `campaignId` | |
| `quoteCallAId` / `CA...` | |
| `quoteCallBId` / `CA...` | |
| `quoteCallCId` / `CA...` | |
| `negotiationAId` | |
| `negotiationBId` | |
| `negotiationCId` | |
| `quoteAId` | |
| `quoteBId` | |
| `quoteCId` | |
| `commitmentId` | |
| `commitCallId` / `CA...` | |
| `summarySid` / `SM...` | |
| `incidentCallId` / `CA...` | |
| `incidentId` | |
| `escalationId` | |
| `conferenceSid` | |
| `pickupCallId` / `CA...` | |
| `operatorClosureCallId` / `deliveryCallId` / `CA...` | |

## Métrica de respuesta hablada

No se exige texto literal del agente. Una respuesta es correcta si contiene todos los hechos obligatorios, no contiene afirmaciones prohibidas y conduce al estado backend esperado.

Cada participante sí debe pronunciar explícitamente los datos críticos: identidad, precio, moneda, pickup, aceptación, incidencia, pickup ocurrido y delivery ocurrido.

---

## Flujo A — El operador crea la operación mediante una llamada de voz

### A1. Registrar o reutilizar los tres carriers

Consultar `GET /api/v1/carriers`.

- Si los teléfonos ya existen, reutilizar sus IDs; no volver a crearlos.
- Si la base está limpia, crear exactamente tres carriers con `POST /api/v1/carriers`.
- Guardar `carrierAId`, `carrierBId` y `carrierCId`.
- Verificar que los teléfonos estén en formato E.164 y que no haya duplicados.

Respuesta esperada:

- tres carriers activos;
- cada participante está asociado al teléfono que realmente contestará;
- ninguna llamada de carrier ha sido creada todavía.

### A2. El operador llama al agente

Desde el teléfono autorizado del operador, llamar al mismo número de Twilio usado por el agente.

Respuesta esperada:

- Twilio invoca el webhook entrante con firma válida;
- se crea una call real `INBOUND/OPERATIONS` con SID `CA...`;
- la identidad se resuelve como `INTERNAL_OPERATOR`, no como carrier, dispatcher o driver;
- el agente se identifica como automatizado y explica que puede crear una operación de drayage;
- la sesión expone `createOperation`, `listCarriers` y `startCampaign`, pero no expone tools de quote, commitment, pickup o delivery;
- una llamada desde un número no autorizado se rechaza sin crear operación ni mandato.

Guardar `operatorCreationCallId` y el SID correspondiente.

### A3. Dictar y confirmar los datos de la operación

El operador dice:

```text
Soy el operador autorizado. Crea una operación para Textiles Pacífico.
El contenedor es TCLU<runId>, sale del Puerto de Manzanillo y va a
Guadalajara. Es servicio de drayage. El máximo autorizado es 9,000 MXN
y el pickup debe ser el 3 de septiembre de 2026. No aceptes cambios de
precio o pickup sin reevaluar el mandato.
```

El agente debe recopilar y confirmar, como mínimo:

- cliente;
- contenedor único;
- origen;
- destino;
- servicio `DRAYAGE`;
- máximo total `9000`;
- moneda `MXN`;
- `pickupDate: 2026-09-03`;
- notas del mandato.

Antes de crear, el agente recapitula todos los campos. Una frase ambigua como “se ve bien” no es autorización suficiente. El operador finalmente dice:

```text
Confirmo que crees esa operación y ese mandato exactamente con esos datos.
```

Solamente después de esa confirmación, el agente ejecuta `createOperation` exactamente una vez con argumentos equivalentes a:

```json
{
  "customerName": "Textiles Pacífico E2E <runId>",
  "containerNumber": "TCLU<runId>",
  "origin": "Puerto de Manzanillo",
  "destination": "Guadalajara",
  "service": "DRAYAGE",
  "mandate": {
    "maxTotalPrice": 9000,
    "currency": "MXN",
    "pickupDate": "2026-09-03",
    "notes": "No aceptar cambios de precio o pickup sin reevaluar el mandato."
  },
  "notes": "TEST-VOICE-01 E2E completo <runId>"
}
```

Guardar `operationId` y `mandateV1Id`.

Inmediatamente después del éxito, sin pedir otra confirmación ni esperar otro endpoint del operador, el agente/orquestador debe:

1. obtener los tres carriers activos del run;
2. ejecutar `startCampaign` una sola vez con esos tres IDs y `maxParallelCalls: 3`;
3. guardar `campaignId`;
4. confirmar por voz que la operación fue creada y que la búsqueda de transporte ya comenzó.

Respuesta esperada:

- la tool responde exitosamente una sola vez;
- operación `CREATED`;
- mandato v1 `ACTIVE`;
- `selectedCarrierId: null`;
- máximo público `9000`, nunca `900000`;
- pickup `2026-09-03`;
- transición automática `CREATED → SOURCING` después de iniciar la campaña;
- exactamente una campaña y tres calls `OUTBOUND/QUOTE` encoladas;
- ninguna selección o commitment antes de que terminen las tres negociaciones;
- el agente pronuncia el `operationId` o una referencia suficiente únicamente después del éxito de la tool;
- la call de operador queda relacionada con la operación creada, con transcript y brief `COMPLETED`.

### A4. Colgar y verificar estado inicial

El operador cuelga después de que el agente confirme la creación.

Consultar:

```http
GET /api/v1/operations/{operationId}
GET /api/v1/operations/{operationId}/status
GET /api/v1/operations/{operationId}/audit-events
GET /api/v1/calls/{operatorCreationCallId}
```

Respuesta esperada:

- operación `SOURCING` y mandato v1 `ACTIVE`;
- call `INBOUND/OPERATIONS/COMPLETED` con SID `CA...` y `endedAt`;
- transcript contiene dictado, recapitulación y confirmación explícita;
- existe un solo evento de creación asociado al actor operador;
- existe una sola campaña automática con tres carriers y `maxParallelCalls: 3`;
- no existe una segunda operación por reintentos de tool o webhooks.

No continuar si la operación no llegó a `SOURCING`, si no existe exactamente una campaña automática o si fue necesario sustituir la call por `POST /operations` o iniciar la campaña manualmente.

---

## Flujo B — Tres llamadas outbound de sourcing

### B1. Verificar el inicio automático de la campaña

No enviar `POST /api/v1/operations/{operationId}/campaigns`. Consultar la operación, la auditoría y la campaña creada automáticamente después de `createOperation`.

Guardar el `campaignId` generado por el orquestador si todavía no se obtuvo en la call de creación.

Respuesta esperada:

- operación `SOURCING`;
- tres negociaciones y tres calls `OUTBOUND/QUOTE`;
- tres SIDs reales `CA...`, nunca `CA_FAKE`;
- cada participante recibe exactamente una llamada;
- no se marca un cuarto número;
- no existe una segunda campaña causada por reintentos;
- no hubo ninguna llamada manual al endpoint de campañas.

### B2. Carrier A entrega una oferta válida

Laura dice:

```text
Habla Laura de Transportes Atlas. Puedo hacerlo por 8,500 pesos mexicanos,
todo incluido, recoger el 3 de septiembre de 2026 y la oferta es válida
hasta el 2 de septiembre de 2026 a las 18:00, hora de Ciudad de México.
```

Durante la respuesta del agente interrumpe una vez:

```text
Perdón, confirma que la ruta es de Manzanillo a Guadalajara.
```

Respuesta esperada:

- el agente maneja el barge-in y confirma la ruta correcta;
- envía `totalPrice: 8500` a la tool, nunca `850000`;
- evalúa y registra exactamente una quote final válida;
- aclara que será comparada;
- no declara ganador ni crea commitment.

Backend esperado:

- call `RINGING → IN_PROGRESS → COMPLETED`;
- quote A `8500 MXN`, `valid: true`, mandato v1;
- negociación A `QUOTED`;
- transcript con la interrupción;
- brief `QUOTE_OBTAINED`;
- un solo SID y una sola quote final.

### B3. Carrier B entrega una oferta fuera del mandato

Bruno dice:

```text
Habla Bruno de Transportes Norte. Son 9,300 MXN, todo incluido, pickup
el 3 de septiembre de 2026. La oferta vence el 2 de septiembre de 2026
a las 18:00, hora de Ciudad de México.
```

Si el agente pide una mejora, responde:

```text
No puedo bajar el precio.
```

Respuesta esperada:

- el agente no acepta ni promete autorización;
- pide una alternativa dentro de las condiciones sin revelar el límite exacto ni quotes ajenas;
- registra el resultado inválido sin inventar una contraoferta.

Backend esperado:

- evaluación `allowed: false`, `PRICE_EXCEEDS_MANDATE`;
- quote B `9300 MXN`, `valid: false` con razón;
- call `COMPLETED`;
- no hay commitment ni cambio de mandato.

### B4. Carrier C corrige la moneda

Carla dice primero:

```text
Habla Carla de Transportes Pacífico. Puedo hacerlo por 500 dólares.
```

Después de que el agente rechace o aclare la moneda, dice:

```text
Entonces cotizo 8,800 MXN, todo incluido, pickup el 3 de septiembre de
2026. La oferta vence el 2 de septiembre de 2026 a las 18:00, hora de
Ciudad de México. Es una cotización, no una reserva.
```

Respuesta esperada:

- el agente no convierte USD por su cuenta;
- el intento USD queda evaluado y rechazado;
- registra una sola quote final de `8800 MXN`;
- no declara ganador.

Backend esperado:

- evidencia auditable del rechazo por moneda;
- quote C `8800 MXN`, `valid: true`;
- call `COMPLETED`, transcript y brief correctos.

### B5. Verificar terminación del sourcing

Consultar:

```http
GET /api/v1/operations/{operationId}/campaigns/{campaignId}
GET /api/v1/operations/{operationId}/quotes
GET /api/v1/operations/{operationId}/audit-events
GET /api/v1/calls/{callId}
GET /api/v1/negotiations/{negotiationId}
```

Respuesta esperada:

- la auditoría demuestra que la campaña alcanzó la compuerta `READY_TO_SELECT` después, y nunca antes, de las tres negociaciones terminales;
- tres negociaciones terminales;
- A y C válidas, B inválida;
- las tres calls tienen `endedAt`;
- no existe selección ni commitment previo a la tercera negociación terminal;
- después de la compuerta, el orquestador continúa automáticamente, por lo que `READY_TO_SELECT` puede ser un estado transitorio no observable mediante polling manual.

---

## Flujo C — Selección y autorización del ganador

### C1. Selección automática del market

No enviar `POST /api/v1/operations/{operationId}/market/selection`. Al recibir el evento persistido que confirma las tres negociaciones terminales, el orquestador ejecuta automáticamente `LOWEST_VALID_TOTAL`.

Guardar `quoteAId` como `winningQuoteId` desde el resultado auditado.

Respuesta esperada:

- A gana con `8500 MXN`;
- B queda excluida por inválida;
- C es válida pero más cara;
- solo existe un evento `MARKET_WINNER_SELECTED`;
- `selectedCarrierId` corresponde a A;
- el cálculo revalida vigencia, moneda, pickup, mandato activo y carrier activo;
- ningún endpoint fue ejecutado manualmente por el operador.

### C2. Autorizar automáticamente el commitment

Después de seleccionar A, el mismo orquestador autoriza automáticamente `quoteAId`. No enviar `POST /api/v1/operations/{operationId}/commitments/authorize`.

Guardar `commitmentId` desde la auditoría o `GET /api/v1/operations/{operationId}/commitments`.

Respuesta esperada:

- un solo commitment `PROPOSED` para A;
- términos `8500 MXN`, pickup `2026-09-03`, mandato v1;
- ningún commitment para B o C;
- la autorización ocurre después de la selección y antes de la call `COMMIT`;
- reintentos del evento no crean un segundo commitment.

---

## Flujo D — Aceptación del ganador y recap

### D1. Encolar automáticamente la call COMMIT

Después de crear el commitment `PROPOSED`, el orquestador encola automáticamente una call `COMMIT` a Carrier A. No enviar `POST /api/v1/operations/{operationId}/calls/outbound`.

Respuesta esperada:

- nuevo SID real `CA...`;
- solo suena el teléfono de A;
- sesión Realtime `COMMIT`;
- tools de commitment disponibles y tools de market/mandato ausentes;
- sólo existe una call `COMMIT` aunque el evento se procese más de una vez;
- el operador no realizó ninguna acción entre la tercera quote y esta llamada.

### D2. Rechazar una frase ambigua

Laura responde primero:

```text
Suena bien, déjame confirmarlo.
```

Respuesta esperada:

- el agente pide una confirmación inequívoca;
- no afirma que el servicio esté reservado;
- commitment permanece `PROPOSED`;
- no existe evidencia ni SMS.

### D3. Confirmar explícitamente

Después de que el agente recapitule contenedor, ruta, pickup, precio y moneda, Laura dice:

```text
Sí, Laura de Transportes Atlas confirma y acepta el servicio por 8,500 MXN,
pickup el 3 de septiembre de 2026, de Manzanillo a Guadalajara.
```

No colgar inmediatamente. Esperar a que el agente confirme el resultado de la tool.

Respuesta esperada:

- el agente registra la aceptación inequívoca una sola vez;
- revalida el commitment contra el mandato activo;
- vincula evidencia al último segmento humano final;
- encola el recap SMS canónico;
- no afirma que el SMS fue entregado antes de que Twilio acepte el envío.

Backend esperado durante la call:

- transiciones `VERBALLY_AGREED → MANDATE_VALIDATED → SUMMARY_PENDING`;
- evidencia con `callId`, `startMs`, `endMs` y extracto exacto;
- Twilio acepta el SMS y entrega un SID `SM...`;
- commitment `SUMMARY_SENT → VALID`;
- operación `BOOKED`;
- carrier A permanece seleccionado.

Si al ejecutar `recordVerbalAgreement` todavía no existe un segmento humano final utilizable, el commitment no debe inventar offsets ni enviar el recap. Si se requiere adjuntar evidencia manualmente para continuar, el flujo de voz estricto queda `BLOCKED`.

### D4. Colgar y verificar persistencia

Después del éxito del backend, finalizar normalmente la llamada.

Consultar:

```http
GET /api/v1/calls/{commitCallId}
GET /api/v1/operations/{operationId}/commitments
GET /api/v1/operations/{operationId}/status
GET /api/v1/operations/{operationId}/audit-events
```

Respuesta esperada:

- call `COMPLETED`, `endedAt` no nulo y sesión liberada;
- transcript conserva la frase de aceptación;
- brief `COMMITTED`;
- commitment `VALID`;
- operación `BOOKED`;
- el teléfono de A recibió un solo recap correcto;
- ninguna llamada o SMS duplicado.

---

## Flujo E — El carrier ganador llama al agente y reporta una incidencia

### E1. Originar la inbound desde el teléfono seleccionado

Desde el mismo número E.164 registrado para Carrier A, llamar al número de Twilio.

Respuesta esperada:

- Twilio invoca el webhook entrante con firma válida;
- HTTP `200` con TwiML de Media Stream;
- se crea una sola call `INBOUND/EXECUTION` con SID real;
- la call queda relacionada con `operationId` y `carrierAId`;
- la sesión expone `getOperation`, `getActiveMandate`, `reportIncident`, `requestEscalation`, `confirmPickup` y `saveCallBrief`;
- el agente no expone operaciones de otros clientes.

No se debe probar este paso desde B o C. Después del booking, solamente el carrier seleccionado debe poder continuar la ejecución de esta operación.

### E2. Identificar la operación

El participante dice:

```text
Soy Juan, conductor de Transportes Atlas. Llamo por el contenedor
TCLU<runId>, de Manzanillo a Guadalajara.
```

Respuesta esperada:

- el agente confirma contenedor y ruta contra el backend;
- no cambia de operación basándose únicamente en una afirmación de voz;
- si los datos no coinciden, pide aclaración y no ejecuta side effects.

### E3. Reportar un cambio fuera del mandato

Juan dice:

```text
El camión asignado se averió. Queremos mover el pickup al 4 de septiembre
y cobrar 1,000 pesos adicionales; el nuevo total sería 9,500 MXN.
```

Respuesta esperada:

- el agente repite fecha y total para confirmar lo entendido;
- registra una incidencia con `reportIncident` y conserva `incidentId`;
- no acepta el cambio;
- no modifica el mandato ni el commitment;
- anuncia que requiere decisión humana;
- solicita escalación relacionada con la misma call e incidencia.

Backend esperado:

- incidencia `OPEN` con tipo, descripción, reporter y `incidentCallId`;
- evento `INCIDENT_REPORTED`;
- escalación `REQUESTED`, razón `OUTSIDE_MANDATE` y resumen exacto;
- operación `ESCALATED`;
- commitment todavía `VALID` y con términos originales.

### E4. Evaluación determinista automática del agente

Inmediatamente después de que `reportIncident` devuelve `incidentId`, el agente ejecuta `evaluateIncidentChange` dentro de la misma call, sin intervención del operador, con argumentos equivalentes a:

```json
{
  "proposedPickupDate": "2026-09-04",
  "proposedTotalPrice": 9500,
  "notes": "Cambio solicitado por avería durante llamada inbound."
}
```

Respuesta esperada:

- la tool responde exitosamente;
- `allowed: false`;
- razones por fecha y precio fuera del mandato;
- `mandateId` igual a `mandateV1Id`;
- incidencia `NEEDS_ESCALATION`;
- ningún cambio en quote, commitment o mandato.

Si el operador debe ejecutar `POST /incidents/{incidentId}/evaluate-change` para continuar, marcar el subpaso y el run global como `PASS ASSISTED`, nunca `PASS AUTONOMOUS`.

### E5. Incorporar al operador humano

Con `HUMAN_ESCALATION_PHONE` configurado, la tool `requestEscalation` crea la escalación y encola automáticamente la unión del humano. El operador debe consultar:

```http
GET /api/v1/escalations/{escalationId}
```

No llamar manualmente `join-human` si la escalación ya está `DIALING_HUMAN` o `HUMAN_JOINED`.

Solamente si el auto-join no estaba configurado y la escalación permanece `REQUESTED`, mientras la call sigue `IN_PROGRESS` enviar `POST /api/v1/escalations/{escalationId}/join-human`:

```json
{
  "humanPhone": "+<numero-operador-consentido>"
}
```

Respuesta esperada:

- el auto-join o el endpoint asistido encolan exactamente un leg humano;
- si se usó el endpoint, responde HTTP `202`;
- escalación `REQUESTED → DIALING_HUMAN → HUMAN_JOINED`;
- existe `conferenceSid` real;
- la call original no se redialea ni se cuelga antes del handoff;
- el agente entrega el contexto antes de salir del Media Stream;
- conductor y operador se escuchan en la misma conferencia.

El operador humano dice:

```text
No autorizo el cambio de fecha ni el incremento. La operación conserva pickup
el 3 de septiembre y total de 8,500 MXN. Necesitamos un camión de reemplazo.
```

El participante confirma:

```text
Entendido. Conseguiremos un camión de reemplazo y mantenemos los términos originales.
```

### E6. Resolver la escalación sin cambiar el mandato

Después de la decisión humana, enviar `POST /api/v1/escalations/{escalationId}/resolve`:

```json
{
  "resolutionSummary": "Cambio rechazado. Carrier mantiene pickup 2026-09-03 y total 8500 MXN con camión de reemplazo."
}
```

Respuesta esperada:

- HTTP `200`;
- escalación `RESOLVED`;
- incidencia `RESOLVED`;
- operación restaurada a `BOOKED`;
- mandato v1 continúa `ACTIVE`;
- commitment continúa `VALID`;
- `selectedCarrierId` continúa siendo A;
- no se creó mandato v2 ni commitment nuevo.

### E7. Finalizar la inbound de incidencia

El participante cuelga después del handoff/resolución.

Respuesta esperada:

- call `COMPLETED` con `endedAt`;
- transcript previo al redirect persistido;
- brief `ESCALATED` o `INCIDENT_REPORTED` con siguiente paso de pickup;
- sesión Realtime liberada;
- sin escalaciones activas.

---

## Flujo F — El conductor confirma pickup por voz

### F1. Nueva inbound desde Carrier A

Con la operación otra vez en `BOOKED`, Carrier A llama nuevamente al número Twilio.

Respuesta esperada:

- nueva call `INBOUND/EXECUTION` con SID distinto;
- sesión `EXECUTION` con `confirmPickup`;
- se resuelve la misma operación y carrier seleccionado.

### F2. Confirmar pickup ocurrido

El conductor dice:

```text
Soy Juan de Transportes Atlas. Confirmo que recogí el contenedor TCLU<runId>
en el Puerto de Manzanillo a las 10:00 del 3 de septiembre de 2026.
```

Respuesta esperada:

- el agente verifica operación `BOOKED` y commitment `VALID`;
- repite contenedor, lugar, fecha, hora y persona;
- ejecuta `confirmPickup` exactamente una vez;
- solo afirma que quedó registrado después del éxito backend.

Backend esperado:

- evento `PICKUP_CONFIRMED` relacionado con `pickupCallId`;
- transición conceptual `PICKED_UP → IN_TRANSIT`;
- operación persistida `IN_TRANSIT`;
- commitment `IN_EXECUTION`;
- repetir la frase o el webhook no duplica el evento.

### F3. Terminar call de pickup

Respuesta esperada:

- call `COMPLETED` con transcript, brief `COMPLETED` y `endedAt`;
- sesión liberada;
- operación permanece `IN_TRANSIT`.

---

## Flujo G — El operador llama para confirmar entrega y cerrar la operación

### G1. Nueva inbound del operador durante tránsito

Con la operación en `IN_TRANSIT` y el commitment en `IN_EXECUTION`, el operador autorizado llama al número Twilio desde su teléfono registrado.

Respuesta esperada:

- nueva call real `INBOUND/DELIVERY` con SID distinto;
- identidad `INTERNAL_OPERATOR` validada antes de exponer side effects;
- sesión `DELIVERY` con `getOperation` y `confirmDelivery`, y sin `confirmPickup`;
- el agente no adivina qué operación cerrar si el operador tiene varias activas;
- el operador debe proporcionar `operationId`, contenedor o una referencia única y el backend debe resolver exactamente esa operación;
- una persona no autorizada o una referencia ambigua no puede cerrar nada.

Guardar la misma call como `operatorClosureCallId` y `deliveryCallId`.

### G2. Solicitar el cierre no equivale a confirmar delivery

El operador dice:

```text
Soy el operador autorizado. Quiero cerrar la orden del contenedor TCLU<runId>.
```

El agente consulta el estado oficial y debe responder con una pregunta explícita equivalente a:

```text
Antes de cerrarla necesito confirmación: ¿el contenedor TCLU<runId> ya fue
entregado físicamente en Guadalajara? Indícame fecha, hora, quién confirma
y si hubo daños o faltantes.
```

El operador responde primero de forma ambigua:

```text
Ya debería haber llegado; ciérrala.
```

Respuesta esperada:

- el agente no ejecuta `confirmDelivery`;
- la operación permanece `IN_TRANSIT`;
- el commitment permanece `IN_EXECUTION`;
- no existe `DELIVERY_CONFIRMED`;
- el agente explica que necesita una confirmación inequívoca de entrega ocurrida.

Una intención de cierre, una ETA, “debería haber llegado”, “probablemente” o una instrucción administrativa no constituyen evidencia de delivery.

### G3. Confirmar explícitamente la entrega

Después de que el agente vuelva a solicitar confirmación, el operador dice:

```text
Confirmo que el contenedor TCLU<runId> fue entregado físicamente en Guadalajara
el 3 de septiembre de 2026 a las 22:00. Yo, Gabriel, operador autorizado,
confirmo la entrega sin daños ni faltantes y solicito cerrar la operación.
```

Respuesta esperada:

- el agente verifica que la operación sigue `IN_TRANSIT`;
- verifica que el commitment ganador sigue `IN_EXECUTION`;
- repite contenedor, destino, fecha, hora, identidad del confirmante y condición de la carga;
- ejecuta `confirmDelivery` exactamente una vez con `occurredAt`, `confirmedBy` y notas derivados de la confirmación explícita;
- sólo afirma que la orden quedó terminada después del éxito backend;
- no crea un estado literal `ENDED`: comunica el cierre contractual `COMPLETED`.

Backend esperado:

- evento `DELIVERY_CONFIRMED` relacionado con `operatorClosureCallId`/`deliveryCallId`;
- actor auditable `INTERNAL_OPERATOR` y `confirmedBy` igual a la identidad verificada;
- transición conceptual `DELIVERED → COMPLETED`;
- operación persistida `COMPLETED`;
- commitment `FULFILLED`;
- `selectedCarrierId` permanece A;
- transcript conserva la petición inicial, la respuesta ambigua, la solicitud de evidencia y la confirmación inequívoca;
- repetir la frase, la tool o el webhook no duplica el evento.

### G4. Terminar la última call

Después de que el agente confirme `COMPLETED`, el operador cuelga.

Respuesta esperada:

- call `COMPLETED`;
- `endedAt` no nulo;
- transcript y brief `COMPLETED`;
- sesión Realtime cerrada/liberada;
- una llamada posterior para la misma orden informa que ya está completada y no genera otra entrega;
- no quedan acciones operativas pendientes.

### G5. Ruta alternativa del conductor

El backend puede conservar la capacidad de que el carrier seleccionado confirme delivery desde su teléfono. Sin embargo, este run ejecuta la ruta de cierre por operador y no ambas. Si el conductor ya confirmó delivery y la operación está `COMPLETED`, la llamada posterior del operador sólo consulta el estado; no vuelve a ejecutar `confirmDelivery`.

---

## Flujo H — Verificación final y cierre “ended”

### H1. Consultar estado oficial

Ejecutar:

```http
GET /api/v1/operations/{operationId}
GET /api/v1/operations/{operationId}/status
GET /api/v1/operations/{operationId}/commitments
GET /api/v1/operations/{operationId}/quotes
GET /api/v1/operations/{operationId}/audit-events
GET /api/v1/calls/{deliveryCallId}
```

Resultado obligatorio:

```text
operation.status = COMPLETED
commitment.status = FULFILLED
deliveryCall.status = COMPLETED
deliveryCall.endedAt != null
selectedCarrierId = carrierAId
```

No se crea un estado adicional `ENDED`: la combinación anterior es la prueba contractual de cierre.

### H2. Verificar evidencia total

| Evidencia | Esperado |
|---|---|
| Twilio Voice | Ocho SIDs `CA...`: creación por operador, tres quote, commit, incidente, pickup y cierre/delivery por operador. El leg humano de conferencia se audita aparte. |
| Twilio SMS | Un solo SID `SM...` dirigido a Carrier A. |
| Calls backend | Ocho calls principales terminales, cada una con correlación uno a uno y `endedAt`. |
| Quotes | A válida `8500`, B inválida `9300`, C válida `8800`. |
| Orquestación | Campaña, selección, autorización y call `COMMIT` iniciadas automáticamente, sin los cuatro endpoints manuales. |
| Market | A como único ganador automático por `LOWEST_VALID_TOTAL`. |
| Commitment | Uno solo para A, autorizado automáticamente: `VALID → IN_EXECUTION → FULFILLED`. |
| Incidencia | Una incidencia ligada a la inbound, evaluada fuera del mandato y finalmente `RESOLVED`. |
| Escalación | `REQUESTED → DIALING_HUMAN → HUMAN_JOINED → RESOLVED`. |
| Pickup | Un `PICKUP_CONFIRMED`, operación `IN_TRANSIT`. |
| Delivery | Un `DELIVERY_CONFIRMED` respaldado por la confirmación inequívoca del operador, operación `COMPLETED`. |
| Auditoría | Sin transiciones, quotes, SMS, calls o side effects duplicados. |

### H3. Timeline mínimo reconstruible

La auditoría debe permitir reconstruir, en orden causal:

```text
OPERATOR_CREATION_CALL
→ OPERATION_CREATED
→ CAMPAIGN_STARTED
→ 3 × QUOTE_CALL
→ MARKET_WINNER_SELECTED
→ COMMITMENT_AUTHORIZED
→ VERBAL_AGREEMENT
→ COMMITMENT_EVIDENCE_ATTACHED
→ SUMMARY_SENT
→ OPERATION_BOOKED
→ INBOUND_INCIDENT_REPORTED
→ INCIDENT_CHANGE_EVALUATED
→ ESCALATION_REQUESTED
→ HUMAN_JOINED
→ ESCALATION_RESOLVED
→ PICKUP_CONFIRMED
→ OPERATOR_CLOSURE_CALL
→ DELIVERY_CONFIRMED
→ OPERATION_COMPLETED
```

Los nombres exactos deben tomarse del backend si difieren, pero no pueden faltar las relaciones a `operationId`, call, carrier, quote, commitment, mandato, incidencia, escalación y actor.

## Condiciones para detener el run

Detener e informar el bloqueo si ocurre cualquiera de estos casos:

- Railway no está `ACTIVE/SUCCESS` para el commit esperado.
- la call del operador no puede autenticarse o no expone `createOperation`;
- la operación se crea por `POST /operations` en lugar de la conversación obligatoria;
- una frase ambigua del operador crea la operación o un retry crea una segunda operación;
- el operador debe iniciar manualmente la campaña, seleccionar, autorizar o encolar la call `COMMIT`;
- el orquestador avanza antes de que las tres negociaciones sean terminales;
- un retry crea una segunda campaña, selección, commitment o call `COMMIT`;
- una oferta hablada de `8500 MXN` llega a la tool como `850000`;
- una call no obtiene SID real `CA...`;
- el WebSocket se desconecta sin transcript ni tool execution;
- una quote o call se duplica;
- se declara ganador durante sourcing;
- B es aceptada pese a exceder el mandato;
- una frase ambigua crea acuerdo o SMS;
- el commitment pasa a `VALID` sin evidencia o sin SID `SM...`;
- una inbound se asocia a la operación o carrier equivocado;
- el agente acepta la incidencia fuera del mandato;
- la escalación intenta unirse después de que la call dejó de estar activa;
- pickup se confirma sin operación `BOOKED` y commitment `VALID`;
- una call de cierre de operador no valida identidad o elige silenciosamente una orden ambigua;
- la frase “ciérrala” o “ya debería haber llegado” ejecuta `confirmDelivery`;
- el cierre necesita `POST /delivery/confirm` manual en lugar de la tool durante la call;
- delivery se confirma sin operación `IN_TRANSIT` y commitment `IN_EXECUTION`;
- la operación queda `COMPLETED` con commitment distinto de `FULFILLED`;
- la última call no queda `COMPLETED` con `endedAt`.

## Criterio global

`PASS AUTONOMOUS` exige que todos los teléfonos, SIDs, conversaciones, tools y estados se correlacionen desde la call PSTN en la que el operador crea la operación hasta la call PSTN en la que el mismo tipo de actor confirma la entrega y obtiene `COMPLETED/FULFILLED`. Después de la confirmación inicial del operador, campaña, tres calls, espera de resultados, selección, autorización y call `COMMIT` deben ocurrir automáticamente. Si cualquiera de esos pasos requiere uno de los cuatro endpoints manuales, si el operador no puede originar la call de cierre o si delivery requiere el endpoint manual, el resultado global es como máximo `PASS ASSISTED` y el objetivo autónomo permanece `BLOCKED`.

El subpaso de incidencia se etiqueta:

- `PASS AUTONOMOUS` si el agente ejecuta también la evaluación determinista dentro de la llamada;
- `PASS ASSISTED` si el operador ejecuta `evaluate-change` por HTTP y todo lo demás ocurre por voz;
- `BLOCKED` si el agente acepta el cambio sin evaluación, no puede escalar o la operación no regresa a `BOOKED`;
- `FAIL` crítico si se excede el mandato, se inventa evidencia, se duplica un side effect o se completa delivery sin evidencia de una call `DELIVERY`.
