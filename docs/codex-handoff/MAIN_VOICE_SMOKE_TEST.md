# Main Voice smoke test

Ejecutar los gates en orden. No avanzar si el gate anterior falla.

## Gate 1 — inbound mínimo

1. Confirmar `GET /api/v1/health` en el deployment.
2. Llamar al número Twilio real y confirmar que el webhook inbound responde.
3. Confirmar un Media Stream real con internalCallId, CallSid y StreamSid persistidos.
4. Confirmar que OpenAI Realtime habla y escucha.
5. El carrier dice explícitamente: “Mi tarifa es ocho mil quinientos pesos, todo incluido”.
6. Confirmar una quote persistida como `850000` centavos MXN con `groundedCallerItemId`, transcript final y rangos raw.
7. Confirmar que call, operation, carrier y negotiation pertenecen al mismo contexto.

Falla si la misma cifra sólo fue dicha por el agente, si un “sí” aislado crea la quote o si aparece cualquier cruce de IDs.

## Gate 2 — ONE OUTBOUND

Preparar operation, mandato, carrier y negotiation oficiales. Ejecutar una llamada outbound y comprobar, en este orden:

`outbound → CallSid → Media Stream → Realtime → grounded quote → DB → transcript → recording`

La grabación debe mostrar RecordingSid, lifecycle y asociación con el mismo internalCallId/CallSid. El alignment exacto puede quedar `UNRESOLVED / RECORDING_START_OFFSET_UNKNOWN`.

## Gate 3 — THREE CALL

Lanzar A/B/C con concurrencia 3. Para cada llamada comparar y conservar aislados:

- internalCallId
- CallSid
- StreamSid
- carrierId
- negotiationId
- Realtime session
- transcript
- quote y grounding
- RecordingSid

Cualquier dato de A en B/C, o StreamSid/RecordingSid reutilizado, es FAIL.

## Gate 4 — TAKEOVER

Usar el `TwilioHumanConferenceGateway` existente, sin reimplementarlo:

1. carrier conectado;
2. crear escalation;
3. redirigir el leg activo a Conference;
4. humano entra y se registra `HUMAN_JOINED`.

Caso no-answer: verificar de forma física el comportamiento seguro. El gateway actual redirige al carrier a Conference y no implementa por sí solo retorno automático al agente si el humano no contesta; por eso no debe declararse PASS sin observarlo.

Al hacer redirect a Conference, el TwiML de Media Stream anterior deja de gobernar el leg y el WebSocket/Realtime puede cerrar. La grabación se inició sobre el CallSid original, pero continuidad, tracks y callback durante el redirect deben verificarse físicamente; no se afirma alignment exacto sin anchor real.
