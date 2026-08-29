# Integración Parte A ↔ Parte B (Voice)

Este documento define el límite estable entre el control plane de Parte A y el
runtime de voz de Parte B. Parte B no modifica mandatos, quotes, commitments ni
estados oficiales directamente.

## Composición recomendada

Parte A conserva la creación de la instancia Drizzle y la entrega al runtime:

```ts
import { createDrizzleVoiceRuntime } from "../modules/voice/voice.runtime";

const voiceRuntime = createDrizzleVoiceRuntime(db, {
  voiceCore,
});

const app = createApp({ voice: { runtime: voiceRuntime } });
```

`createDrizzleVoiceRuntime` conecta, sin modificar el schema:

- `DrizzleCallRepository`.
- `DrizzleAuditEventRepository`.
- Cola en memoria con concurrencia 3 y dos reintentos.
- Twilio real cuando existen todas las variables requeridas.
- Sesiones Realtime efímeras.

## Contrato que implementa Parte A

Parte A implementa `VoiceCorePort`, ubicado en
`src/modules/voice/voice-core.port.ts`.

Responsabilidades:

- Resolver y validar el contexto outbound.
- Resolver llamadas inbound sin inventar operaciones.
- Entregar el mandato activo exacto.
- Ejecutar las tools deterministas solicitadas por Realtime.

El servicio `CallsService` implementa `CallScheduler`. Parte A puede inyectarlo
directamente en campañas y llamar `enqueueQuoteCalls`; no debe hacer HTTP hacia
el mismo monolito.

Para recaps de commitments, Parte A puede depender de `SummarySender`. Parte B
incluye `TwilioSmsSummarySender`; Parte A conserva la transición oficial de
`SUMMARY_PENDING` a `SUMMARY_SENT` y `VALID`.

`executeVoiceTool` debe delegar a los mismos services usados por los endpoints
HTTP de Parte A. No debe reimplementar reglas en el adapter.

La sesión Realtime verifica que la tool esté permitida para su modo antes de
invocar `VoiceCorePort`.

## Decisiones temporales explícitas

- `FOLLOW_UP` se persiste como `EXECUTION`; no se cambia el check SQLite.
- `RENEGOTIATION` usa las tools del modo `QUOTE`.
- `ESCALATION` usa las tools del modo `INCIDENT`.
- `DISPATCHER` utiliza Logistics Agent. Parte A puede mapearlo a `CARRIER` para
  auditoría mientras el esquema no soporte ese actor.
- Las sesiones Realtime viven en memoria. `calls.realtime_session_id` conserva
  la correlación durante una llamada activa.

## Garantías de Parte B

- No se guarda audio ni URLs de grabación.
- Transcript consolidado se guarda en `calls.transcript_text` al cerrar sesión.
- Webhooks status repetidos no vuelven a emitir transiciones.
- Estados terminales no regresan a estados activos.
- El `callId` viaja en la ruta del Media Stream para construir las tools antes
  de conectar OpenAI.
- Un retry posterior a la creación en Twilio no vuelve a marcar el número.

## Variables requeridas para telefonía real

Consultar `.env.example`. `PUBLIC_BASE_URL` debe ser HTTPS y `PUBLIC_WSS_URL`
debe ser WSS. Sin credenciales, el runtime utiliza telefonía falsa y no realiza
llamadas externas.
