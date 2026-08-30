# TEST-BE-00 — Protocolo para agentes de prueba

## Objetivo

Preparar un entorno backend aislado y repetible en el que agentes de IA simulen operadores, carriers y conductores mediante datos estructurados, sin audio, PSTN, Twilio ni OpenAI externos.

## Autoridad del ejecutor

El agente puede iniciar servidores locales, crear una base temporal, inyectar fakes, hacer solicitudes a `127.0.0.1` y añadir pruebas automatizadas cuando esa sea su tarea explícita. No puede:

- usar credenciales reales;
- abrir un túnel público;
- marcar teléfonos o enviar SMS;
- relajar aserciones o modificar datos esperados para obtener un `PASS`;
- reutilizar `sqlite.db` del desarrollador;
- borrar o sobrescribir cambios ajenos del working tree.

## Topología del arnés

```text
Agente orquestador
├─ cliente HTTP local
├─ Carrier A simulado (respuesta JSON/texto)
├─ Carrier B simulado (respuesta JSON/texto)
├─ Carrier C simulado (respuesta JSON/texto)
├─ FakeTelephonyGateway
├─ FakeSummarySender
├─ FakeConferenceGateway
├─ VoiceCorePort conectado a services deterministas
├─ reloj e IDs controlables
└─ SQLite temporal exclusiva del proceso
```

Los simuladores de carrier solo producen hechos conversacionales. No escriben en la base y no deciden si una oferta es válida.

## Fakes obligatorios

### `FakeTelephonyGateway`

Debe registrar cada invocación y responder:

```json
{
  "providerCallId": "CA_FAKE_<callId>"
}
```

Una invocación repetida para el mismo `callId` debe ser visible como defecto. El fake nunca abre sockets ni usa el SDK real de Twilio.

### `FakeSummarySender`

Debe registrar `channel`, `recipient` y `message`, y responder:

```json
{
  "providerId": "SM_FAKE_<commitmentId>",
  "acceptedAt": "2026-09-01T12:10:00.000Z"
}
```

Aceptar el mensaje significa aceptación del proveedor, no lectura humana.

### `FakeConferenceGateway`

Debe registrar una sola solicitud de unión para la llamada activa y responder con un identificador `CF_FAKE_<escalationId>`. No debe marcar al humano.

### `VoiceCorePort` de prueba

Debe delegar a los mismos services deterministas usados por HTTP. Solo se permite sustituir adaptadores externos, reloj, generación de IDs y almacenamiento temporal. Una implementación que responde siempre `{ "ok": true }` no prueba el E2E y debe fallar.

## Preflight obligatorio

| Paso | Acción | Respuesta esperada | Criterio |
|---:|---|---|---|
| 1 | Guardar `git rev-parse HEAD` y `git status --short`. | SHA no vacío y cambios ajenos documentados. | No se altera ni limpia el working tree. |
| 2 | Comprobar que las variables `TWILIO_*` y `OPENAI_API_KEY` no serán consumidas por el proceso de prueba. | Runtime compuesto con fakes. | Cero clientes externos construidos. |
| 3 | Crear un directorio y SQLite temporales por suite. | Ruta fuera de la base de desarrollo, eliminable al terminar. | Ninguna suite comparte conexión o archivo. |
| 4 | Fijar el reloj en `2026-09-01T12:00:00.000Z`. | Timestamps deterministas. | No se comparan tiempos con `Date.now()` real. |
| 5 | Ejecutar `npm run typecheck`. | Código de salida `0`. | De lo contrario, `BLOCKED`. |
| 6 | Ejecutar `npm run validate:openapi`. | `openapi.yaml is valid`. | De lo contrario, `BLOCKED`. |
| 7 | Levantar la app solo en `127.0.0.1` y consultar `GET /api/v1/health`. | `200`, `{"status":"ok","service":"nextwave-voice-logistics-api"}` y `x-request-id`. | El servicio está listo. |
| 8 | Recorrer los 36 operations declarados en OpenAPI con IDs/body inválidos controlados. | Ninguno responde `ROUTE_NOT_FOUND` ni `5xx`; cada uno rechaza o procesa según contrato. | Paridad ruta/contrato completa. |
| 9 | Consultar una ruta inexistente. | `404` con `code: "ROUTE_NOT_FOUND"`. | El not-found común funciona. |
| 10 | Enviar JSON malformado a un POST. | `400`, `code: "INVALID_JSON"` y mensaje no vacío. | No hay mutación parcial. |

## Reglas de orquestación

1. Ejecutar cada archivo con un `runId` nuevo.
2. Capturar todos los IDs de las respuestas; nunca adivinarlos.
3. Esperar explícitamente `queue.onIdle()` antes de afirmar efectos de un job.
4. Consultar el estado persistido después de cada mutación.
5. Cuando no exista lectura HTTP, verificar mediante repository/service inyectado en el mismo arnés.
6. Registrar las llamadas de los fakes y compararlas con la cardinalidad esperada.
7. Deshabilitar o interceptar DNS/HTTP saliente; cualquier intento de red externa es `FAIL` crítico.
8. Ejecutar suites que escriben SQLite de forma serial si el proyecto aún usa una conexión global. Un `SQLITE_BUSY` es un defecto de aislamiento, no un éxito intermitente.

## Respuestas y comparaciones

- Los códigos HTTP son exactos.
- Los campos monetarios de entrada están en unidades (`9000` MXN). La persistencia interna puede usar centavos, pero debe equivaler exactamente a `900000`.
- Fechas se comparan como instantes ISO equivalentes.
- Arrays de auditoría se comparan por orden temporal y relación de IDs.
- Texto generado por un agente se compara semánticamente, excepto precio, moneda, fecha, contenedor, origen, destino y la confirmación explícita, que deben coincidir exactamente.
- Ninguna respuesta `5xx` es aceptable en los flujos normales o negativos previstos.

## Plantilla de un simulador de carrier

El orquestador entrega:

```json
{
  "operation": {
    "containerNumber": "1234",
    "origin": "Puerto de Manzanillo",
    "destination": "Guadalajara"
  },
  "prompt": "Proporciona únicamente la oferta asignada a tu rol. No decidas si es válida."
}
```

El simulador devuelve únicamente:

```json
{
  "speaker": "CARRIER",
  "totalPrice": 8500,
  "currency": "MXN",
  "pickupDate": "2026-09-03",
  "utterance": "Puedo hacerlo por 8,500 MXN y recoger el 3 de septiembre."
}
```

Si el agente agrega descuentos, condiciones o autorizaciones no indicadas, el paso falla.

## Criterio global

`PASS` exige que los diez pasos de preflight terminen correctamente, que core y voice compartan el mismo almacenamiento temporal, que todos los fakes tengan conteos observables y que no exista ningún intento de red externa. Un singleton sobre `sqlite.db`, una ruta contractual no montada o un proveedor real construido deja el protocolo en `FAIL`/`BLOCKED`.

## Limpieza y reporte

Al finalizar se cierran servidor, cola, sesiones y conexiones SQLite. Solo se elimina el directorio temporal creado por la suite después de verificar su ruta absoluta. El reporte debe usar el formato de [`../README.md`](../README.md) e incluir:

- conteo de invocaciones de cada fake;
- estados finales y eventos de auditoría;
- cualquier drift entre OpenAPI y rutas reales;
- confirmación explícita de cero tráfico externo.
