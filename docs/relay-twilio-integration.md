# RELAY Twilio Integration

## Purpose

RELAY es un servicio de voz aislado y físicamente validado hasta Checkpoint 3. El team backend y la UI deben consumir sus resultados; no deben reimplementar telefonía, Media Streams ni OpenAI Realtime.

Baseline exacta:

```text
RELAY commit 541f4e645ad00919b89da6395f6886496599dfae
checkpoint-3 negotiator core validated
```

## Boundary

Flujo de control:

```text
TEAM APP
   |
   | future HTTP command / persisted operation
   v
RELAY VOICE SERVICE
   |
   | TwiML + bidirectional Media Stream
   v
TWILIO
   |
   v
PSTN CARRIER
```

Flujo de resultados:

```text
PSTN CARRIER
   |
   v
TWILIO
   |
   v
RELAY
   |
   | structured transcript / quotes / eligibility
   v
TEAM APP
```

El WebSocket de voz termina en RELAY. La UI nunca debe estar en el audio path. El backend Express raíz y RELAY Fastify siguen siendo procesos separados.

## Ownership

RELAY owns:

- Twilio inbound TwiML and voice callbacks.
- Media Stream WebSocket.
- OpenAI Realtime session and voice-agent lifecycle.
- Barge-in and transcript observation.
- CallSid/StreamSid call context.
- Relay Negotiator and function tools.
- Deterministic quote validation for the current fixture.

Team app owns or will own:

- Users and operator-facing UI.
- Operations and carrier registry.
- Mandate creation/versioning.
- Persistent database and authorization.
- Market orchestration and ranking.
- Dashboard/read models.

Shared contract to design next:

- Start a negotiation for an existing operation and registered carrier.
- Supply Relay with operation and mandate versions.
- Receive call/quote/events idempotently.
- Query call transcript and market state.
- Never send a raw arbitrary phone number from a public endpoint.

## Stable versus deferred

| Capability | Integration state |
|---|---|
| Checkpoint 1 Twilio webhook/TwiML | Included, physically validated |
| Checkpoint 2 PSTN/Media Streams/Realtime/barge-in | Included, physically validated |
| Checkpoint 3 Negotiator/quotes/mandate validation | Included, physically validated |
| Checkpoint 4 recording/timing/debug inspector | Excluded from this baseline |
| Stream-to-recording evidence correlation | Not final; remains `UNRESOLVED` in development work |
| Outbound real calls | Not implemented |
| Three concurrent carriers | Not implemented |
| Persistence | Not implemented in RELAY service |

Checkpoint 4 is not classified as broken. It is excluded because its current RELAY implementation lives after the stable Checkpoint 3 commit and does not yet have its own validated checkpoint commit.

## Runtime configuration

RELAY expects these server-side variables:

```text
PORT
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
OPENAI_API_KEY
REALTIME_MODEL
REALTIME_VOICE
VOICE_MODE
PUBLIC_BASE_URL
```

No `.env`, API key, token, recording, `.tmp`, node_modules or cache may be copied into Git.

## Current integration risks

- Stores are in-memory and disappear on restart.
- The demo operation/mandate is an explicit fixture.
- Twilio signature validation is still a TODO.
- There is no durable contract yet between the root Express API and RELAY.
- Changes to the voice bridge require coordination because it has passed physical PSTN tests.
