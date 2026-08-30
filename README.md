# HACKATHON_NW2026

Backend monolítico para la demo NextWave 2026. La IA conversa y propone; los
services deterministas validan, persisten y cambian el estado oficial.

## Inicio local

```powershell
npm install
npm start
```

- API: `http://127.0.0.1:3000/api/v1`
- Swagger: `http://127.0.0.1:3000/docs`
- Health: `http://127.0.0.1:3000/api/v1/health`

Sin credenciales se usa un gateway telefónico falso. Para Twilio y OpenAI
Realtime, copia `.env.example` a `.env` mediante el mecanismo de variables de tu
entorno y completa los secretos sin versionarlos.

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
