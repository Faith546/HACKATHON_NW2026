# TEST-VOICE-03 — Calidad de voz y fallos de telefonía

## Objetivo

Medir que la experiencia telefónica es suficientemente natural para la demo y que errores de PSTN, red y webhooks terminan en estados seguros, sin duplicar llamadas ni decisiones.

## Precondiciones

- `TEST-VOICE-00` está en `PASS`.
- Se usa una operación desechable por escenario.
- Todos los teléfonos pertenecen al equipo de prueba.
- El operador puede observar timestamps de Twilio, backend y transcript con relojes sincronizados.

## SLO de aceptación de la demo

| Señal | Umbral |
|---|---:|
| Primer audio del agente después de contestar | `<= 4 s` |
| Latencia desde fin del turno humano hasta inicio de respuesta | mediana `<= 2.5 s`, máximo `<= 5 s` en cinco turnos |
| Corte del audio del agente tras barge-in | `<= 1 s` |
| Exactitud de precio, moneda, fecha, contenedor y sí/no | `100 %` |
| Calls o SMS duplicados | `0` |
| Contaminación de contexto entre llamadas | `0` |
| Estado terminal backend después de colgar | `<= 30 s` |
| Aceptación del recap por Twilio | `<= 60 s` desde el enqueue |

Los umbrales son criterios de esta demo; cualquier cambio debe acordarse antes de ejecutar, no después de observar resultados.

## Q1 — Barge-in real

Durante una respuesta de al menos cinco segundos, interrumpir tres veces en momentos distintos con:

```text
Un momento, corrige el precio: son 8,500 MXN.
```

Respuesta esperada:

- El audio del agente se corta en menos de un segundo.
- No continúa hablando encima del participante.
- Reconoce la corrección y usa `8500 MXN` en la siguiente evaluación.
- Cada turno cortado aparece como interrumpido en transcript.
- No se ejecuta dos veces la misma tool por la interrupción.

## Q2 — Latencia y turn-taking

Realizar cinco turnos cortos: identidad, ruta, fecha, precio y confirmación.

Respuesta esperada:

- Se cumplen mediana y máximo de la tabla.
- No hay silencios indefinidos ni respuestas antes de que la persona termine.
- La respuesta final refleja los cinco hechos exactos.
- Los offsets del transcript son crecientes y razonables respecto de Twilio.

## Q3 — Silencio

Contestar una call outbound y permanecer en silencio durante 15 segundos; después decir “hola”.

Respuesta esperada:

- El agente puede hacer una repregunta breve, sin repetirla en bucle.
- Al escuchar “hola”, retoma el flujo sin crear otra call o sesión.
- No registra quote, acuerdo o incidencia durante el silencio.

Si existe un timeout conversacional configurado, debe cerrar de forma cordial y auditable, no quedarse activo indefinidamente.

## Q4 — No answer y busy

### No answer

No contestar una llamada hasta que Twilio finalice el intento.

Respuesta esperada:

- Call `NO_ANSWER`, `endedAt` no nulo.
- Negociación terminal sin quote.
- Cero sesión Realtime y cero transcript inventado.
- No hay redial automático fuera de la política explícita.

### Busy/rechazo

Rechazar la llamada de forma que el proveedor reporte `busy` cuando la red lo soporte.

Respuesta esperada:

- Call `BUSY`.
- Mismas garantías de ausencia de quote/commitment.
- Si la red transforma el rechazo en otro estado, registrar el estado real del proveedor; no falsificar `BUSY`.

## Q5 — Hangup abrupto

Contestar, dar una oferta parcial y colgar mientras el agente habla, antes de que `recordQuote` confirme éxito.

Respuesta esperada:

- Twilio y backend terminan la call en un estado terminal.
- La sesión se limpia y persiste los segmentos disponibles.
- El último turno del agente puede quedar interrumpido.
- No aparece una quote si la tool no terminó exitosamente.
- No se redializa ni se crea commitment.

## Q6 — Pérdida del túnel o Media Stream

En un ambiente controlado, interrumpir temporalmente el túnel WSS durante una call de prueba. No realizarlo en una demo activa.

Respuesta esperada:

- El bridge cierra/libera la sesión y espera los writes de transcript ya recibidos.
- La call termina `FAILED` o con el estado terminal que Twilio reporte; no queda eternamente `IN_PROGRESS`.
- No se reintenta la llamada sin una política explícita.
- La siguiente call nueva puede abrir un stream limpio, sin contexto anterior.

## Q7 — Webhooks duplicados y regresivos

Usar las herramientas de prueba/replay de Twilio para reenviar un status callback ya recibido, y luego uno anterior si la herramienta lo permite.

Respuesta esperada:

- HTTP `204` para eventos soportados y firmados.
- No se duplica auditoría.
- Una call `COMPLETED`, `BUSY`, `NO_ANSWER` o `FAILED` nunca vuelve a `RINGING/IN_PROGRESS`.
- `startedAt` y `endedAt` no cambian en replays.

## Q8 — Caller desconocido y privacidad

Llamar desde un número consentido que no está registrado como carrier.

Respuesta esperada:

- El backend no inventa operación/carrier.
- La respuesta vocal, si existe un fallback autorizado, no revela nombres, rutas, precios ni contenedores.
- No se crea incidencia, quote o commitment.
- El intento queda registrado de forma mínima y sin exponer el número completo en reportes.

## Q9 — Tres llamadas simultáneas

Iniciar la campaña canónica y hacer que los tres participantes contesten con menos de cinco segundos de diferencia.

Respuesta esperada:

- Exactamente tres calls activas como máximo.
- Cada persona escucha exclusivamente su propia conversación.
- Cada sesión conserva su carrier, negociación, mandato y transcript.
- Una interrupción o hangup de A no afecta B/C.
- No se cruzan quotes, SIDs ni call briefs.

## Q10 — Firma y URLs seguras

Enviar una copia manual del webhook sin firma y después observar una solicitud real firmada.

Respuesta esperada:

- La copia falsa responde `403 INVALID_TWILIO_SIGNATURE` sin mutación.
- La real se procesa.
- Todas las URLs de callbacks son HTTPS y Media Stream usa WSS.
- Ningún token aparece en query strings.

## Q11 — Recap duplicado o fallido

Provocar un único fallo recuperable del envío SMS usando una configuración de prueba controlada por el proveedor.

Respuesta esperada:

- La política hace como máximo tres intentos totales.
- Un retry no genera dos mensajes aceptados; si Twilio acepta dos SIDs, el caso falla.
- Commitment permanece fuera de `VALID` mientras ningún envío sea aceptado.
- Tras una aceptación única, termina `VALID` con un SID.

No provocar fallos enviando mensajes repetidos manualmente al participante.

## Criterio global y evidencia

Para cada escenario registrar timestamps, estado Twilio, estado backend, IDs enmascarados, transcript y conteo de side effects. No conservar audio.

`PASS` exige todos los SLO y escenarios aplicables. Un contexto cruzado, decisión duplicada, fuga de datos, transición regresiva o llamada no consentida es `FAIL` crítico y detiene la suite.
