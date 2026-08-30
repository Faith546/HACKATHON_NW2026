import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import {
  RealtimeSession,
  type RealtimeItem,
} from "@openai/agents/realtime";
import type { FastifyPluginAsync } from "fastify";
import { createRelayNegotiator } from "../agents/relay-negotiator.js";
import { demoInboundCarrierId, demoMandate } from "../fixtures/demo-operation.js";
import { transcriptBus, type TranscriptTurn } from "../live/transcript.js";
import { callContextStore } from "../stores/call-context-store.js";
import { callTimingStore } from "../stores/call-timing-store.js";
import { startTwilioRecordingForCall } from "../telephony/twilio-recording.js";

type TwilioMessage = {
  event?: string;
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    callSid?: string;
    streamSid?: string;
  };
  media?: {
    timestamp?: string;
    track?: string;
    chunk?: string;
  };
};

type OpenAISpeechEvent = {
  type: "input_audio_buffer.speech_started" | "input_audio_buffer.speech_stopped";
  item_id?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
};

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "error" in value) {
    return errorMessage(value.error);
  }
  return String(value);
}

function transcriptText(item: RealtimeItem): string | null {
  if (item.type !== "message" || item.role === "system") return null;

  const text = item.content
    .map((content) => {
      if ("transcript" in content) return content.transcript;
      if ("text" in content) return content.text;
      return null;
    })
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .trim();

  return text || null;
}

const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/media/twilio", { websocket: true }, async (socket) => {
    console.info("[VOICE] Twilio WebSocket connected");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("[OPENAI] OPENAI_API_KEY is missing");
      socket.close(1011, "OpenAI configuration missing");
      return;
    }

    // Keep this adapter responsible for codec handling, timing, and interruption.
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: socket,
    });

    let activeCallId: string | undefined;
    let activeStreamSid: string | undefined;
    let callStartedAtMs: number | undefined;
    let firstMediaLogged = false;
    const firstSeenAtByTurn = new Map<string, number>();
    const printedFinalItems = new Set<string>();
    const agent = createRelayNegotiator({
      getCallContext: () =>
        activeCallId ? callContextStore.get(activeCallId) : undefined,
    });
    const realtimeVoice = process.env.REALTIME_VOICE?.trim() || "ash";

    const session = new RealtimeSession(agent, {
      transport,
      model: process.env.REALTIME_MODEL || "gpt-realtime-2.1",
      config: {
        outputModalities: ["audio"],
        reasoning: {
          effort: "low",
        },
        audio: {
          input: {
            transcription: {
              model: "gpt-live-transcribe",
              delay: "low",
              languages: ["es", "en"],
              prompt:
                "A bilingual Spanish and English logistics rate negotiation by telephone.",
            },
            turnDetection: {
              type: "semantic_vad",
              eagerness: "medium",
              createResponse: true,
              interruptResponse: true,
            },
          },
          output: {
            voice: realtimeVoice,
          },
        },
      },
    });

    let closed = false;

    const closeSession = () => {
      if (closed) return;
      closed = true;
      session.close();
      console.info("[VOICE] session closed");
    };

    const observeTranscriptItem = (
      item: RealtimeItem,
      interruptedOverride = false,
    ) => {
      if (!activeCallId || callStartedAtMs === undefined) return;
      if (item.type !== "message" || item.role === "system") return;

      const text = transcriptText(item);
      if (!text) return;

      const firstSeenAt =
        firstSeenAtByTurn.get(item.itemId) ?? Date.now() - callStartedAtMs;
      firstSeenAtByTurn.set(item.itemId, firstSeenAt);

      const turn: TranscriptTurn = {
        callId: activeCallId,
        turnId: item.itemId,
        speaker: item.role === "user" ? "caller" : "relay",
        text,
        timestampMs: firstSeenAt,
        final: item.status !== "in_progress",
        interrupted: interruptedOverride || item.status === "incomplete",
      };

      try {
        transcriptBus.publish(turn);
      } catch (error) {
        // Observability must never terminate the Realtime audio session.
        console.error(`[TRANSCRIPT] observer error: ${errorMessage(error)}`);
      }

      if (item.status === "completed" && !printedFinalItems.has(item.itemId)) {
        console.info(`${item.role === "user" ? "[CALLER]" : "[RELAY]"} ${text}`);
        printedFinalItems.add(item.itemId);
      }
    };

    socket.addEventListener("close", () => {
      console.info("[VOICE] Twilio WebSocket disconnected");
      closeSession();
    });

    socket.addEventListener("error", (error) => {
      console.error(`[VOICE] WebSocket error: ${errorMessage(error)}`);
      closeSession();
    });

    session.on("transport_event", (event) => {
      if (
        event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped"
      ) {
        const speechEvent = event as OpenAISpeechEvent;
        if (!activeCallId || !speechEvent.item_id) return;

        if (speechEvent.type === "input_audio_buffer.speech_started") {
          const observed = callTimingStore.observeSpeechStarted(
            activeCallId,
            speechEvent.item_id,
            speechEvent.audio_start_ms,
          );
          if (observed) {
            console.info(
              `[TIMING] caller speech started\nClock: openai_input\nItemId: ${speechEvent.item_id}\nStart: ${speechEvent.audio_start_ms}`,
            );
          }
        } else {
          const observed = callTimingStore.observeSpeechStopped(
            activeCallId,
            speechEvent.item_id,
            speechEvent.audio_end_ms,
          );
          if (observed) {
            console.info(
              `[TIMING] caller speech stopped\nClock: openai_input\nItemId: ${speechEvent.item_id}\nEnd: ${speechEvent.audio_end_ms}`,
            );
          }
        }
        return;
      }

      if (event.type !== "twilio_message") return;

      const message = event.message as TwilioMessage;

      if (message.event === "connected") {
        console.info("[TWILIO] connected");
      }

      if (message.event === "start") {
        const callId = message.start?.callSid;
        const streamSid = message.start?.streamSid ?? message.streamSid;

        console.info("[TWILIO] start");
        console.info(`[TWILIO] CallSid: ${callId ?? "unknown"}`);
        console.info(`[TWILIO] StreamSid: ${streamSid ?? "unknown"}`);

        if (!callId) {
          console.error("[VOICE] Twilio start did not include CallSid");
        } else {
          const startedAt = new Date();
          activeCallId = callId;
          activeStreamSid = streamSid;
          callStartedAtMs = startedAt.getTime();
          callContextStore.startCall({
            callId,
            operationId: demoMandate.operationId,
            mandateVersion: demoMandate.version,
            startedAt: startedAt.toISOString(),
            streamSid,
            carrierId: demoInboundCarrierId,
          });

          if (streamSid) {
            callTimingStore.startStream(callId, streamSid);
            console.info(
              `[TIMING] stream started\nCallSid: ${callId}\nStreamSid: ${streamSid}`,
            );
          } else {
            console.error("[TIMING] Twilio start did not include StreamSid");
          }

          void startTwilioRecordingForCall(callId).catch((error) => {
            console.error(
              `[RECORDING] start failed\nCallSid: ${callId}\nError: ${errorMessage(error)}`,
            );
          });
        }
      }

      if (message.event === "media" && message.media && message.streamSid) {
        const observed = callTimingStore.observeMedia({
          streamSid: message.streamSid,
          timestamp: message.media.timestamp,
          sequenceNumber: message.sequenceNumber,
          chunk: message.media.chunk,
          track: message.media.track,
        });

        if (observed && !firstMediaLogged) {
          firstMediaLogged = true;
          const timing = callTimingStore.getByStreamSid(message.streamSid);
          console.info(
            `[TIMING] first media\nClock: twilio_stream\nTimestamp: ${timing?.stream.firstMediaTimestampMs ?? "unknown"}`,
          );
        }
      }

      if (message.event === "stop") {
        console.info("[TWILIO] stop");
        const timing = activeStreamSid
          ? callTimingStore.getByStreamSid(activeStreamSid)
          : undefined;
        console.info(
          `[TIMING] last media\nClock: twilio_stream\nTimestamp: ${timing?.stream.lastMediaTimestampMs ?? "unknown"}`,
        );
        closeSession();
      }
    });

    session.on("history_updated", (history) => {
      for (const item of history) observeTranscriptItem(item);
    });

    session.on("audio_interrupted", () => {
      console.info("[VOICE] agent audio interrupted by caller");

      const latestRelayItem = [...session.history]
        .reverse()
        .find(
          (item) =>
            item.type === "message" &&
            item.role === "assistant" &&
            Boolean(transcriptText(item)),
        );

      if (latestRelayItem) observeTranscriptItem(latestRelayItem, true);
      if (activeCallId) {
        try {
          transcriptBus.markLatestRelayInterrupted(activeCallId);
        } catch (error) {
          console.error(
            `[TRANSCRIPT] interruption observer error: ${errorMessage(error)}`,
          );
        }
      }
    });

    session.on("error", (error) => {
      console.error(`[OPENAI] session error: ${errorMessage(error)}`);
      closeSession();
      socket.close(1011, "OpenAI session error");
    });

    console.info(`[VOICE] Realtime voice: ${realtimeVoice}`);
    console.info("[OPENAI] connecting");
    try {
      await session.connect({ apiKey });
      console.info("[OPENAI] connected");
    } catch (error) {
      console.error(`[OPENAI] connection failed: ${errorMessage(error)}`);
      closeSession();
      socket.close(1011, "OpenAI connection failed");
    }
  });
};

export default mediaRoutes;
