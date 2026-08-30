# TEST-VOICE-02 — Inbound, incidente, escalación, pickup y delivery

## Objetivo

Validar con voz real que un conductor conocido puede llamar, reportar una incidencia, ser escalado sin perder la llamada y posteriormente confirmar pickup y delivery bajo las reglas oficiales.

## Precondiciones

- `TEST-VOICE-00` está en `PASS`.
- Existe una operación del fixture con carrier ganador, commitment `VALID` y teléfono del participante correctamente asociado.
- Las rutas de incidents, escalations, execution y audit están montadas.
- Existe un adapter real de conferencia Twilio.
- La resolución inbound asigna modos `INCIDENT`, `EXECUTION` y `DELIVERY` según estado/intención de forma demostrable. Si toda llamada `IN_TRANSIT` queda forzada a `INCIDENT` y nunca puede alcanzar `confirmDelivery`, el caso está `BLOCKED`.
- El humano interno está disponible en un número consentido distinto.

## Flujo A — Entrada e identidad

### A1. Llamar al número Twilio

El participante llama desde el teléfono registrado para el carrier ganador.

Respuesta esperada:

- Twilio invoca el voice webhook con firma válida y recibe TwiML HTTP `200`.
- Se crea una sola call `INBOUND` con SID real, carrier y operación correctos.
- Media Stream WSS se conecta usando el `callId` de esa call.
- El agente se identifica como automatizado y confirma únicamente el contexto mínimo necesario.
- No menciona operaciones de otros clientes ni pide que el caller elija entre datos privados.

### A2. Confirmar el contexto

El participante dice:

```text
Soy Juan, conductor de Transportes Atlas. Llamo por el contenedor
TCLU1234567, de Manzanillo a Guadalajara.
```

Respuesta hablada esperada:

- El agente confirma el mismo contenedor y ruta.
- Si los datos no coinciden con la resolución backend, pide aclaración y no ejecuta tools.
- No cambia carrier u operación basándose solo en la afirmación de voz.

## Flujo B — Incidencia dentro del mandato

### B1. Reportar retraso permitido

El conductor dice:

```text
Tendré un retraso de dos horas, pero recojo el mismo 3 de septiembre
y no cambia el precio de 8,500 MXN.
```

Respuesta hablada esperada:

- El agente repite fecha y precio para confirmar que entendió.
- Registra la incidencia y consulta el mandato activo.
- Informa que el cambio está dentro de los límites sin presentar nuevas condiciones.

Backend esperado:

- Incidencia `OPEN → ALLOWED_CHANGE` o `RESOLVED`.
- Evaluación `allowed: true`, `code: ALLOWED`, con el mandato activo.
- Operación y commitment conservan sus términos.
- No existe escalación ni llamada al humano.

## Flujo C — Corrección fuera del mandato

### C1. Solicitar fecha y costo nuevos

El conductor corrige:

```text
En realidad será el 4 de septiembre y necesitamos 1,000 MXN adicionales;
el total sería 9,500 MXN.
```

Respuesta hablada esperada:

- El agente no acepta el cambio.
- Explica que fecha/precio quedan fuera de su autorización y que necesita a un humano.
- No modifica el mandato ni el commitment.

Backend esperado:

- Se registra una nueva incidencia o una revisión auditable de la activa.
- Evaluación `allowed: false` con razones de fecha/precio y el mandato vigente.
- Incidencia `NEEDS_ESCALATION`.
- Escalación `REQUESTED`, motivo `OUTSIDE_MANDATE` y resumen exacto.

## Flujo D — Conferencia humana sin colgar

### D1. Solicitar unión

El agente anuncia que incorporará a un operador y ejecuta `join-human`.

Respuesta esperada:

- Endpoint responde `202`.
- Escalación pasa `REQUESTED → DIALING_HUMAN`.
- La llamada del conductor permanece activa con el mismo SID/callId.
- Twilio crea o usa una conferencia y marca únicamente `HUMAN_ESCALATION_PHONE`.
- El conductor escucha una indicación neutral de espera, no una confirmación anticipada.

### D2. Humano entra a la conversación

El operador contesta. Carrier y humano dicen su nombre una vez.

Respuesta esperada:

- Conductor y humano se escuchan sin redial al conductor.
- El redirect de Twilio puede cerrar el Media Stream y sacar al agente de la conversación; debe anunciar el handoff antes de hacerlo y persistir el transcript previo.
- Escalación `HUMAN_JOINED` solo después de que el humano realmente contesta y Twilio confirma su participación, no al crear el leg saliente.
- No hay eco severo, mezcla entre otras calls ni pérdida del transcript de la call original.

### D3. Autorizar mediante mandato v2

El humano dice que autoriza el nuevo total/fecha y, desde la interfaz o API de operador, crea mandato v2 por `9500 MXN` y `2026-09-04`.

Respuesta hablada y backend esperados:

- La frase del humano por sí sola no cambia el estado oficial.
- Mandato v1 queda `SUPERSEDED`; v2 queda `ACTIVE` y auditado con actor humano.
- Si el agente salió al transferir, se inicia después una call `RENEGOTIATION/FOLLOW_UP`; esa nueva sesión vuelve a invocar `getActiveMandate` y recibe v2.
- Solo después de esa lectura, el backend reevalúa: `allowed: true`, `code: ALLOWED`, `mandateId: mandateV2Id`.
- El agente de la call de seguimiento puede confirmar los términos autorizados y la escalación queda `RESOLVED`.

### D4. Finalizar la llamada

El conductor y el humano se despiden; el conductor cuelga.

Respuesta esperada:

- Call `COMPLETED`, conferencia terminada y sesión liberada.
- Transcript distingue los speakers disponibles y conserva la secuencia de autorización.
- Brief `ESCALATED` o `INCIDENT_REPORTED`, con next step de pickup.
- No se guarda audio.

## Flujo E — Confirmar pickup por voz

### E1. Nueva llamada del conductor

El conductor llama de nuevo y dice:

```text
Confirmo que recogí el contenedor TCLU1234567 en Manzanillo
a las 14:00 del 4 de septiembre.
```

Respuesta hablada esperada:

- El agente verifica operación, commitment válido y estado actual.
- Repite contenedor, lugar y hora.
- Ejecuta `confirmPickup` una sola vez y confirma únicamente después del éxito backend.

Backend esperado:

- Sesión en modo `EXECUTION` con `confirmPickup` disponible y `confirmDelivery` ausente.
- La respuesta final deja la operación `IN_TRANSIT`; `PICKED_UP` queda como transición conceptual auditada.
- Commitment `IN_EXECUTION`.
- Un `PICKUP_CONFIRMED` relacionado con la call.
- Repetir la frase no duplica el evento.

## Flujo F — Confirmar delivery por voz

### F1. Nueva llamada desde operación en tránsito

El conductor dice:

```text
Confirmo entrega del contenedor TCLU1234567 en Guadalajara
a las 22:00 del 4 de septiembre.
```

Respuesta hablada esperada:

- La sesión expone `confirmDelivery` mediante modo `DELIVERY`.
- El agente verifica estado y repite destino/hora.
- Solo afirma que quedó entregado después de recibir éxito del backend.

Backend esperado:

- HTTP/tool result exitoso.
- La respuesta final deja la operación `COMPLETED`; `DELIVERED` queda como transición conceptual auditada.
- Commitment `FULFILLED`.
- Un solo `DELIVERY_CONFIRMED`.
- La call termina `COMPLETED`, con transcript y brief `COMPLETED`.

## Verificación final

La auditoría debe permitir reconstruir:

```text
INBOUND_CALL
→ INCIDENT_ALLOWED
→ INCIDENT_OUTSIDE_MANDATE
→ ESCALATION_REQUESTED
→ HUMAN_JOINED
→ MANDATE_V2_CREATED
→ CHANGE_ALLOWED
→ PICKUP_CONFIRMED
→ DELIVERY_CONFIRMED
→ OPERATION_COMPLETED
```

Los nombres exactos de eventos deben coincidir con el contrato del backend; no pueden faltar las relaciones a call, incidencia, escalación, mandato y actor.

## Criterio global

`PASS` exige voz bidireccional, conferencia real sin colgar, relectura del mandato v2 y estados finales consistentes. Aceptar el cambio antes de v2, marcar `HUMAN_JOINED` sin humano, o confirmar delivery mediante una sesión sin esa tool es `FAIL` crítico.
