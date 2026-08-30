# TEST-VOICE-01 — Tres llamadas outbound, negociación y commitment

## Objetivo

Probar con PSTN y voz real que el sistema llama a tres carriers, conversa con interrupciones, registra tres resultados, selecciona un único ganador, obtiene aceptación inequívoca y envía un recap SMS correcto.

## Precondiciones

- `TEST-VOICE-00` está en `PASS` para el mismo commit y ambiente.
- Los tres participantes están listos y tienen sus guiones.
- La base de demo está limpia y el túnel permanecerá estable.
- No hay otras campañas o llamadas activas.
- El operador tiene a la vista Twilio Console, logs sanitizados y consultas del backend.

## Métrica de respuesta hablada

No se exige texto literal. Una respuesta hablada es correcta si contiene todos los hechos obligatorios, no contiene ninguna afirmación prohibida y conduce al estado backend esperado.

## Flujo A — Preparación

### A1. Registrar carriers y operación

Crear los tres carriers con los números consentidos y luego la operación canónica con límite `9000 MXN` y pickup `2026-09-03`.

Respuesta esperada:

- tres HTTP `201` para carriers;
- HTTP `201` para operación;
- operación `CREATED`, mandato v1 `ACTIVE`;
- números almacenados en formato E.164;
- ninguna llamada antes de iniciar la campaña.

### A2. Iniciar campaña

Enviar `POST /api/v1/operations/{operationId}/campaigns` con los tres IDs y `maxParallelCalls: 3`.

Respuesta esperada:

- HTTP `202`;
- operación `SOURCING`;
- tres negociaciones y tres calls `OUTBOUND/QUOTE`;
- Twilio entrega tres SIDs reales con prefijo `CA`, nunca `CA_FAKE`;
- no se marca un cuarto número;
- cada participante recibe exactamente una llamada.

## Flujo B — Carrier A, oferta válida

### Guion humano

1. Contestar: “Habla Laura de Transportes Atlas”.
2. Esperar que el agente explique la operación.
3. Ofrecer: “Puedo hacerlo por 8,500 pesos mexicanos, recoger el 3 de septiembre, y la oferta es válida hasta hoy a las seis de la tarde, hora de México”.
4. Mientras el agente responde, interrumpir una vez: “Perdón, confirma que es de Manzanillo a Guadalajara”.
5. Confirmar la ruta y despedirse sin afirmar que ya está reservado.

### Respuesta hablada esperada

- El agente se identifica como asistente automatizado y explica el propósito.
- Menciona contenedor, origen, destino y fecha correctos.
- Se detiene al ser interrumpido y responde la pregunta de ruta.
- Evalúa `8500 MXN` contra el backend y comunica que la cotización con esa vigencia quedó registrada/será comparada.
- No inventa la vigencia: la obtiene de la frase del carrier.
- No dice “ganaste”, “está reservado” ni crea un commitment.

### Backend esperado

- Call: `RINGING → IN_PROGRESS → COMPLETED`.
- Quote: `valid: true`, `8500 MXN`, fecha correcta y mandato v1.
- Negociación: `QUOTED`.
- Transcript contiene presentación, oferta, interrupción y respuesta; el turno interrumpido está marcado.
- Brief `QUOTE_OBTAINED`.
- Un solo SID y una sola quote.

## Flujo C — Carrier B, oferta fuera de mandato

### Guion humano

1. Identificarse como Bruno de Transportes Norte.
2. Ofrecer: “Son 9,300 MXN para el 3 de septiembre, válida hasta hoy a las seis de la tarde, hora de México”.
3. Si el agente pide mejorar, responder: “No puedo bajar el precio”.
4. Despedirse.

### Respuesta hablada esperada

- El agente no acepta ni promete autorización.
- Explica de manera neutral que la oferta no cumple las condiciones autorizadas y pregunta si existe una alternativa dentro de ellas.
- Al recibir la negativa, registra el resultado sin inventar una contraoferta.
- No revela información sobre ofertas de otros carriers.

### Backend esperado

- Evaluación `allowed: false`, `PRICE_EXCEEDS_MANDATE`.
- Quote registrada como `valid: false` con razón.
- Call terminal `COMPLETED` y brief `NO_AGREEMENT` o `QUOTE_OBTAINED` según la convención elegida, pero siempre consistente con una quote inválida.
- No hay commitment ni cambio de mandato.

## Flujo D — Carrier C, corrección de moneda

### Guion humano

1. Identificarse como Carla de Transportes Pacífico.
2. Decir primero: “Puedo hacerlo por 500 dólares”.
3. Cuando el agente aclare la moneda autorizada, corregir: “Entonces 8,800 MXN, pickup el 3 de septiembre, válida hasta hoy a las seis de la tarde, hora de México”.
4. Confirmar que es una cotización, no una reserva.

### Respuesta hablada esperada

- El agente no convierte divisas ni acepta USD por su cuenta.
- Indica que necesita términos en MXN.
- Evalúa y registra solamente la oferta final `8800 MXN`.
- Aclara que será comparada y no declara un ganador.

### Backend esperado

- El intento USD queda rechazado/auditado como evaluación, sin quote final en USD.
- Existe una sola quote final para C, válida por `8800 MXN`.
- Call `COMPLETED`, transcript y brief correctos.

## Flujo E — Comparación y autorización

### E1. Verificar los tres resultados

Consultar campaña y quotes.

Respuesta esperada:

- campaña `READY_TO_SELECT`, tres negociaciones terminales y tres quotes;
- A y C válidas, B inválida;
- ninguna selección o commitment previo.

### E2. Ejecutar Market Selection

Usar estrategia `LOWEST_VALID_TOTAL`.

Respuesta esperada:

- HTTP `200`;
- A gana con `8500 MXN`;
- la explicación muestra que B fue inválida y C era más cara;
- solo existe un `MARKET_WINNER_SELECTED`.

### E3. Autorizar commitment

Autorizar `quoteAId`.

Respuesta esperada:

- HTTP `201`, commitment `PROPOSED` para Carrier A;
- ningún commitment para B/C;
- repetir la autorización responde `409` y no crea un segundo cierre.

## Flujo F — Llamada real al ganador

### F1. Encolar call COMMIT

Crear una llamada outbound `COMMIT` a Carrier A.

Respuesta esperada:

- HTTP `202` y un nuevo SID real;
- solo suena el teléfono de A;
- sesión Realtime `COMMIT` con tools de commitment y sin tools de mandato/market.

### F2. Probar que una frase ambigua no compromete

El participante escucha los términos y responde primero: “Suena bien, déjame confirmarlo”.

Respuesta hablada esperada:

- El agente pide una confirmación inequívoca.
- No afirma que el servicio esté cerrado.

Backend esperado:

- commitment continúa `PROPOSED`;
- no hay evento de acuerdo ni SMS.

### F3. Confirmar explícitamente

El agente debe recapitular contenedor, ruta, pickup, precio y moneda. El participante responde:

```text
Sí, Laura de Transportes Atlas confirma el servicio por 8,500 MXN,
pickup el 3 de septiembre, de Manzanillo a Guadalajara.
```

Respuesta hablada esperada:

- El agente reconoce la confirmación sin alterar términos.
- Indica que se enviará un recap escrito.
- No promete que el SMS ya fue entregado antes de que el proveedor lo acepte.

Backend esperado durante la call:

- se registra el acuerdo explícito y se revalida el mandato activo;
- commitment pasa por `VERBALLY_AGREED` y `MANDATE_VALIDATED`;
- el transcript conserva la frase exacta y sus offsets.

### F4. Colgar y procesar evidencia

Finalizar normalmente la llamada. La arquitectura actual consolida el transcript al cerrar; por tanto la evidencia y el SMS deben procesarse en un paso post-call, no suponerse disponibles antes del hangup.

Respuesta esperada:

- call `COMPLETED`, transcript persistido y sesión liberada;
- un orquestador post-call automático encuentra el intervalo de la confirmación y adjunta `callId`, `startMs`, `endMs` y extracto exacto;
- no se guarda audio ni recording URL;
- si el extracto no coincide, el commitment no avanza y no se envía recap.

La evidencia no puede adjuntarse desde la sesión Realtime ya cerrada. Si no existe ese orquestador y el operador debe llamar manualmente el endpoint para continuar, el flujo real queda `BLOCKED`; esa intervención no cuenta como E2E.

### F5. Recibir recap SMS

El participante espera el mensaje en el mismo teléfono consentido.

Contenido obligatorio:

- contenedor del `runId`;
- Manzanillo → Guadalajara;
- pickup 3-sep-2026;
- `8,500 MXN`;
- identificación suficiente de la operación.

Respuesta backend esperada:

- estado inmediato `SUMMARY_PENDING` al encolar;
- SID real de mensaje con prefijo `SM` después de aceptación Twilio;
- transición `SUMMARY_SENT → VALID`;
- operación `BOOKED`, carrier seleccionado A;
- el SMS recibido coincide con el payload auditado.

## Verificación final

| Evidencia | Esperado |
|---|---|
| Twilio Voice | Cuatro SIDs reales: tres quotes y un commit. |
| Twilio SMS | Un solo SID real dirigido a Carrier A. |
| Calls backend | Cuatro calls terminales, correlacionadas uno a uno. |
| Quotes | A válida 8500, B inválida 9300, C válida 8800. |
| Market | Ganador A, estrategia y explicación auditadas. |
| Commitment | Uno solo, `VALID`, evidencia de transcript y recap. |
| Auditoría | Sin transiciones ni side effects duplicados. |

## Criterio global

`PASS` exige que todos los teléfonos, SIDs, conversaciones y estados se correlacionen. Cualquier llamada falsa, redial, ganador declarado durante sourcing, aceptación de la quote B, compromiso por frase ambigua o `VALID` antes del SMS es `FAIL` crítico.
