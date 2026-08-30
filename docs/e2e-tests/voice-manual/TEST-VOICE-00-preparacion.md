# TEST-VOICE-00 — Preparación segura para voz real

Configura explícitamente `VOICE_RUNTIME_MODE=twilio`. El valor por defecto y el
valor recomendado fuera de esta prueba es `VOICE_RUNTIME_MODE=local`.

## Objetivo

Verificar que la aplicación está realmente conectada a Twilio, OpenAI Realtime y los services deterministas antes de permitir que una persona haga llamadas o envíe SMS con costo.

## Ejecutor autorizado

Este caso solo puede ejecutarlo una persona con control de la cuenta Twilio, los números de prueba, el túnel y el presupuesto. Un agente de IA puede explicar los pasos, pero no debe iniciarlos, usar credenciales ni marcar por cuenta propia.

## Condiciones de seguridad

- Usar únicamente números propios o de participantes que dieron consentimiento explícito.
- No usar carriers, conductores o clientes reales.
- Si la cuenta Twilio es trial, verificar previamente todos los destinos requeridos.
- Definir un límite de gasto y revisar el precio de voz/SMS aplicable.
- No habilitar grabación. La evidencia será transcript, offsets, estados y SIDs.
- No pegar secretos, auth tokens ni números personales completos en issues o reportes.
- Detener inmediatamente si se marca un número no previsto.

## Gate 1 — Backend estable

Antes de configurar telefonía:

```powershell
npm run typecheck
npm test
npm run validate:openapi
```

Respuesta esperada:

- los tres procesos terminan con código `0`;
- no hay `SQLITE_BUSY`, pruebas intermitentes ni rutas OpenAPI sin montar;
- los cinco `TEST-BE-*` tienen reporte `PASS` en el mismo commit.

Si alguna condición falla, el resultado es `BLOCKED` y no se realizan llamadas.

## Gate 2 — Composición real del servidor

Una revisión de solo lectura debe demostrar todo lo siguiente:

| Componente | Condición necesaria |
|---|---|
| Persistencia de voice | El servidor usa el runtime Drizzle, no repositories en memoria para calls/audit. |
| Core | `VoiceCorePort.executeVoiceTool()` delega a los services oficiales y no devuelve `503`. |
| Outbound | El runtime construye `TwilioTelephonyGateway` con las credenciales configuradas. |
| Inbound | `resolveInboundCallContext()` consulta carriers/operaciones reales de la base de demo. |
| Realtime | `TwilioMediaBridge` está unido al mismo servidor HTTP y usa el mismo runtime. |
| Recap | Commitments usa `TwilioSmsSummarySender`, no un sender local que acepta todo. |
| Escalación | Existe adapter de conferencia Twilio y `join-human` está montado. |
| API | Incidents, escalations, execution y audit están montados bajo `/api/v1`. |

Una configuración donde `src/server.ts` llama el runtime fallback, genera `CA_FAKE_*`, mantiene calls solo en memoria o usa un recap falso debe producir `BLOCKED`, aunque las variables de entorno existan.

## Gate 3 — Variables y URLs

Configurar fuera de Git:

```text
PORT=3000
HOST=127.0.0.1
PUBLIC_BASE_URL=https://<host-publico>
PUBLIC_WSS_URL=wss://<host-publico>
TWILIO_ACCOUNT_SID=<secreto>
TWILIO_AUTH_TOKEN=<secreto>
TWILIO_PHONE_NUMBER=<numero-twilio>
OPENAI_API_KEY=<secreto>
REALTIME_MODEL=gpt-realtime
REALTIME_VOICE=ash
HUMAN_ESCALATION_PHONE=<numero-consentido>
```

Respuesta esperada:

- `PUBLIC_BASE_URL` usa HTTPS válido y llega al proceso local.
- `PUBLIC_WSS_URL` usa WSS y admite upgrade WebSocket.
- Los secretos no aparecen en `git status`, logs ni Swagger.
- Reiniciar el servidor carga la configuración sin imprimir valores sensibles.

## Gate 4 — Configuración de Twilio

En el número Twilio de prueba configurar el webhook de voz entrante:

```text
POST https://<host-publico>/api/v1/webhooks/twilio/voice
```

Las llamadas outbound deben configurar automáticamente:

```text
POST https://<host-publico>/api/v1/webhooks/twilio/status?callId=<callId>
wss://<host-publico>/ws/twilio-media/<callId>
```

Respuesta esperada:

- Twilio puede resolver el dominio y validar TLS.
- El webhook sin firma enviado manualmente responde HTTP `403 INVALID_TWILIO_SIGNATURE`.
- Un intento manual de upgrade WSS sin firma Twilio también se rechaza y no crea una sesión.
- Una solicitud firmada por Twilio no se rechaza por firma.
- El stream incluye `callId` tanto en la ruta como en `<Parameter>`.

## Gate 5 — Salud y datos de prueba

Consultar:

```http
GET https://<host-publico>/api/v1/health
GET https://<host-publico>/openapi.yaml
```

Respuesta esperada:

- Health: HTTP `200`, `status: ok` y service correcto.
- OpenAPI: HTTP `200` y el mismo contrato validado localmente.
- Se usará una base exclusiva de demo, sin operaciones reales.

Preparar cuatro participantes o dispositivos:

| Rol | Uso |
|---|---|
| Carrier A | Oferta válida de 8,500 MXN y commitment. |
| Carrier B | Oferta inválida de 9,300 MXN. |
| Carrier C | Corrección de moneda y oferta de 8,800 MXN. |
| Humano interno | Unión a conferencia durante escalación. |

Cada persona recibe su guion antes de comenzar y confirma que puede colgar en cualquier momento.

## Gate 6 — Observabilidad

Preparar una carpeta de evidencias fuera de Git con:

- hora de inicio y zona horaria;
- commit probado;
- `operationId`, `callId` internos y SIDs parcialmente enmascarados;
- respuestas HTTP sanitizadas;
- eventos de auditoría;
- screenshots del estado de Twilio sin tokens ni números completos;
- transcript y offsets, pero ninguna grabación.

## Stop conditions

No continuar si ocurre cualquiera de estas condiciones:

- aparece `CA_FAKE_*` o `SM_FAKE_*`;
- una tool responde `VOICE_CORE_UNAVAILABLE`/`VOICE_CORE_TOOL_UNAVAILABLE`;
- Twilio acepta la llamada pero no abre Media Stream;
- falta validación de firma;
- el número destino no pertenece al grupo consentido;
- incidents/escalations/execution no están montados para el caso que se pretende ejecutar;
- el backend no puede demostrar qué mandato autorizó una decisión.

## Criterio global

`PASS` significa que los seis gates están satisfechos y la primera llamada real puede realizarse de forma controlada. Este archivo no coloca ninguna llamada por sí mismo.
