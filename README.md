# HACKATHON_NW2026

Backend monolítico para la demo NextWave 2026. La IA conversa y propone; los
services deterministas validan, persisten y cambian el estado oficial.

## Inicio local

```powershell
npm install
npm run db:migrate
npm start
```

- API: `http://127.0.0.1:3000/api/v1`
- Swagger: `http://127.0.0.1:3000/docs`
- Health: `http://127.0.0.1:3000/api/v1/health`

`VOICE_RUNTIME_MODE=local` usa gateways falsos y no hace llamadas externas. Para
Twilio y OpenAI Realtime, copia `.env.example` a `.env`, cambia explícitamente a
`VOICE_RUNTIME_MODE=twilio` y completa los secretos sin versionarlos. El modo
Twilio también exige URLs públicas `https`/`wss`; el backend falla al iniciar si
falta alguna variable requerida.

La creación y administración de operaciones se realiza únicamente por el API
HTTP documentado en Swagger. Realtime cubre las conversaciones logísticas sobre
una llamada ya asociada a una operación; el modo inalcanzable `CREATE_OPERATION`
fue retirado del contrato público.

## Voice runtime

Implementado:

- Encolado y consulta de llamadas outbound.
- Cola en memoria con concurrencia máxima de tres.
- Repositorio de calls en memoria y adapter Drizzle.
- Call briefs y transcript consolidado.
- Webhooks voice/status de Twilio con validación de firma e idempotencia.
- Twilio Media Streams bidireccional hacia OpenAI Realtime.
- Barge-in mediante VAD semántico y `TwilioRealtimeTransportLayer`.
- Sesiones Realtime con tools limitadas estructuralmente por modo.
- Adapter Twilio SMS para recaps.
- Sin grabación de audio; sólo se persisten transcript y brief.

La integración exacta con los services de Parte A está documentada en
[`docs/05-integracion-parte-a-voice.md`](docs/05-integracion-parte-a-voice.md).

## Verificación

```powershell
npm run typecheck
npm test
npm run validate:openapi
```

## RELAY Voice Service (External integration)

La integración funcional de Twilio PSTN y OpenAI Realtime vive en [`relay/apps/server`](relay/apps/server).

Consulta [`relay/README.md`](relay/README.md) para configuración, ejecución y responsabilidades del servicio.

# Raily: asistente de consulta logística

El frontend puede consultar a Raily mediante `POST /api/relay-llm/chat`. La clave de OpenAI nunca se expone al cliente: el backend obtiene el contexto operativo desde su propia base de datos y llama al proveedor.

```bash
curl -X POST http://127.0.0.1:3000/api/relay-llm/chat \
  -H "content-type: application/json" \
  -d '{"message":"¿Qué mandatorios tienen retraso?","operationId":"op_123"}'
```

`conversationId` y `operationId` son opcionales. En esta primera versión `conversationId` se acepta como identificador opaco, pero no se persiste ni se usa como fuente de contexto. El resultado tiene la forma `{"reply":"...","inScope":true}`. Las consultas ajenas a Relay/logística devuelven `inScope: false` y una respuesta fija.

Variables necesarias:

- `CHAT_FRONTEND_API_KEY`: requerida para consultas dentro del alcance.
- `CHAT_FRONTEND_MODEL`: opcional; por defecto `gpt-4.1-mini`.
