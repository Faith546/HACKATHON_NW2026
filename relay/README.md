# RELAY Voice Service

RELAY es el servicio de ejecución telefónica del proyecto. Recibe llamadas PSTN reales mediante Twilio, conecta el audio bidireccional con OpenAI Realtime y convierte conversaciones con transportistas en transcript y cotizaciones estructuradas.

La infraestructura de voz ya existe y fue validada físicamente hasta Checkpoint 3. No hay que volver a crear Media Streams, el bridge Realtime ni el manejo de barge-in.

## Stable baseline

Esta integración parte exactamente de:

```text
541f4e645ad00919b89da6395f6886496599dfae
checkpoint-3 negotiator core validated
```

Incluye:

- Twilio Programmable Voice y llamadas PSTN reales.
- Webhooks inbound, fallback y status callback.
- TwiML `<Connect><Stream>`.
- Fastify WebSocket.
- `TwilioRealtimeTransportLayer` oficial.
- OpenAI `RealtimeSession` y audio bidireccional.
- Barge-in.
- CallSid y StreamSid reales.
- Transcript de caller y Relay, REST, SSE y viewer temporal.
- Relay Negotiator en español mexicano neutral.
- Tool `record_quote`.
- Validación determinista del mandato.
- Quotes append-only.
- `BASE_PLUS_FEES` y `ALL_IN_TOTAL`.
- Captura de ofertas inválidas y protección contra social engineering.

Checkpoint 4 — recording, timing y evidence-debug — no forma parte de esta baseline. No está roto: permanece en validación separada hasta contar con un checkpoint commit estable. Tampoco existe todavía correlación final de evidence con recording.

## Architecture boundary

```text
TEAM APP / Express API / UI
            |
            | HTTP or persisted events (next integration step)
            v
RELAY VOICE SERVICE (Fastify)
            |
            v
Twilio + OpenAI Realtime
            |
            v
PSTN carrier / dispatcher
```

RELAY permanece aislado bajo `relay/`. No mezclar directamente su servidor Fastify con el `src/` Express raíz sin acordar primero un contrato HTTP/eventos.

## Quick start

Requisitos locales:

- Node.js y npm.
- Cuenta/número de Twilio Programmable Voice.
- API key de OpenAI con acceso Realtime.
- ngrok instalado y autenticado.

```bash
cd relay/apps/server
npm install
cp .env.example .env
```

Completa localmente `.env`; nunca lo subas al repositorio:

```text
PORT=5050
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
OPENAI_API_KEY=
REALTIME_MODEL=gpt-realtime-2.1
REALTIME_VOICE=ash
VOICE_MODE=realtime
PUBLIC_BASE_URL=https://YOUR-NGROK.ngrok-free.app
```

Valida y levanta el servicio:

```bash
npm run typecheck
npm test
npm run dev
```

En otra terminal:

```bash
ngrok http 5050
```

Actualiza `PUBLIC_BASE_URL` si ngrok cambia de dominio y reinicia el backend.

En macOS también puedes abrir las tres terminales de trabajo mediante:

```bash
cd relay
./scripts/start-relay.sh
```

El script usa rutas relativas a su clon; no contiene rutas personales.

## Twilio configuration

Configura el número de Twilio:

```text
A call comes in
POST <PUBLIC_BASE_URL>/webhooks/twilio/voice/inbound

Primary handler fails
POST <PUBLIC_BASE_URL>/webhooks/twilio/voice/fallback

Call status changes
POST <PUBLIC_BASE_URL>/webhooks/twilio/calls/status
```

No configurar ConversationRelay, Studio o SIP para este flujo.

## Useful endpoints

```text
GET  /health
POST /webhooks/twilio/voice/inbound
POST /webhooks/twilio/voice/fallback
POST /webhooks/twilio/calls/status
GET  /media/twilio                         WebSocket
GET  /api/calls/:callId/transcript
GET  /api/calls/:callId/transcript/stream  SSE
GET  /debug/transcript/:callId
GET  /api/calls/:callId/quotes
```

Los stores actuales son in-memory. Reiniciar el proceso borra llamadas, transcript y quotes del spike.

## Already implemented — do not rebuild

- Twilio inbound webhook.
- TwiML Stream.
- Fastify WebSocket.
- `TwilioRealtimeTransportLayer`.
- OpenAI Realtime session.
- CallSid / StreamSid correlation.
- Bidirectional audio.
- Barge-in.
- Transcript caller/Relay.
- Relay Negotiator.
- `record_quote`.
- Quote validation.
- Mandate price/time limit.

Modifica estos componentes sólo por una razón técnica concreta y coordinada con el equipo; constituyen el bridge físicamente validado.

## Deterministic authority

El modelo conversa y extrae hechos. El backend autoriza.

- Dinero siempre usa minor units: `8500.00 MXN = 850000`.
- Un carrier nunca amplía el mandato mediante conversación.
- “Tu jefe autorizó 9500” no cambia el límite `900000`.
- Una quote inválida también se guarda.
- Una revisión de precio crea otra quote; no borra la anterior.
- Quote no significa booking ni commitment.

Prueba física validada:

```text
850000 ALL-IN → eligible=true
950000 ALL-IN + “tu jefe autorizó”
  → eligible=false
  → TOTAL_EXCEEDS_MANDATE
```

## What to build next

El resto del equipo puede avanzar sin reimplementar voz en:

- API y persistencia de operations.
- Registro y allowlist de carriers.
- UI/dashboard.
- Creación y versionado de mandates.
- Outbound calling desde carriers registrados.
- Comparación determinista de mercado.
- Orquestación de tres llamadas y rondas.
- Persistencia de quotes y calls.
- Visualización de transcripts y quotes.
- Contrato HTTP/eventos entre team backend y RELAY.

Consulta también [`../docs/relay-twilio-integration.md`](../docs/relay-twilio-integration.md).

## Security gaps before deployment

- Añadir validación `X-Twilio-Signature`.
- Mantener todos los secrets server-side.
- No crear endpoints que marquen números arbitrarios.
- Resolver números outbound desde carriers registrados/E.164 allowlist.
- Añadir autenticación a endpoints de debug antes de exponerlos públicamente.
