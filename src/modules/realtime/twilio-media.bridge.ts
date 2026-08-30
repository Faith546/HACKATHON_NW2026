import type { IncomingMessage, Server } from "node:http";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import {
  RealtimeAgent,
  RealtimeSession as OpenAIRealtimeSession,
  tool,
  type RealtimeItem,
} from "@openai/agents/realtime";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import twilio from "twilio";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";
import type { VoiceToolName } from "../voice/voice-core.port";
import {
  voiceToolDescriptions,
  voiceToolSchemas,
} from "../voice/voice-tools";
import {
  modeForCallPurpose,
  type RealtimeService,
} from "./realtime.service";
import type { RealtimeSession, TranscriptSegment } from "./realtime.types";

export interface TwilioMediaBridgeConfig {
  apiKey: string;
  twilioAuthToken: string;
  publicWssUrl: string;
  model?: string;
  voice?: string;
  requireValidSignature?: boolean;
}

type TwilioMessage = {
  event?: string;
  streamSid?: string;
  start?: {
    callSid?: string;
    streamSid?: string;
    customParameters?: Record<string, string>;
  };
  media?: {
    timestamp?: string;
    track?: string;
    chunk?: string;
  };
};

export class TwilioMediaBridge {
  private readonly webSocketServer = new WebSocketServer({ noServer: true });

  constructor(
    private readonly callsService: CallsService,
    private readonly realtimeService: RealtimeService,
    private readonly config: TwilioMediaBridgeConfig,
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const match = /^\/ws\/twilio-media\/([^/]+)$/.exec(url.pathname);
      if (!match) return;
      if (!this.hasValidTwilioSignature(request, url.pathname)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const callId = decodeURIComponent(match[1]);
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void this.handleConnection(webSocket, callId).catch(() => {
          webSocket.close(1011, "Realtime bridge failed");
        });
      });
    });
  }

  private hasValidTwilioSignature(
    request: IncomingMessage,
    path: string,
  ): boolean {
    if (this.config.requireValidSignature === false) return true;
    const rawSignature = request.headers?.["x-twilio-signature"];
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;
    if (!signature || !this.config.twilioAuthToken.trim()) return false;
    const publicUrl = new URL(this.config.publicWssUrl);
    publicUrl.pathname = path;
    publicUrl.search = "";
    publicUrl.hash = "";
    const target = publicUrl.toString();
    return (
      twilio.validateRequest(
        this.config.twilioAuthToken,
        signature,
        target,
        {},
      ) ||
      twilio.validateRequest(
        this.config.twilioAuthToken,
        signature,
        target.endsWith("/") ? target : `${target}/`,
        {},
      )
    );
  }

  private async handleConnection(
    webSocket: WebSocket,
    callId: string,
  ): Promise<void> {
    if (!this.config.apiKey.trim()) {
      webSocket.close(1011, "OpenAI configuration missing");
      return;
    }
    // Attach Twilio's transport and a correlation listener synchronously,
    // before any database await. Twilio can emit `start` immediately after
    // the WebSocket upgrade and does not replay missed frames.
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: webSocket,
    });
    const startMessagePromise = captureTwilioStart(webSocket);
    const call = await this.callsService.getById(callId);
    const start = await startMessagePromise;
    if (start.customParameters?.callId !== callId) {
      webSocket.close(1008, "Call context mismatch");
      throw new ApiError(
        422,
        "CALL_CONTEXT_MISMATCH",
        "El callId del Media Stream no coincide con la ruta firmada.",
      );
    }
    if (!start.callSid) {
      webSocket.close(1008, "CallSid missing");
      throw new ApiError(
        422,
        "CALL_PROVIDER_ID_REQUIRED",
        "Twilio no incluyó CallSid en el evento start.",
      );
    }
    await this.callsService.ensureProviderCallId(callId, start.callSid);
    await this.callsService.applyProviderStatus(
      start.callSid,
      "IN_PROGRESS",
    );
    void this.callsService.startRecording(callId).catch(() => undefined);
    const sessionContext = await this.realtimeService.create({
      callId,
      actorType: "CARRIER",
      carrierId: call.carrierId,
      operationId: call.operationId,
      negotiationId: call.negotiationId,
      mode: modeForCallPurpose(call.purpose),
    });
    let transcriptWriteChain = Promise.resolve();
    let transcriptWriteError: unknown = null;
    const waitForTranscript = async () => {
      await transcriptWriteChain;
      if (transcriptWriteError) {
        throw new ApiError(
          503,
          "TRANSCRIPT_PERSISTENCE_FAILED",
          "No se pudo persistir el transcript antes de ejecutar la tool.",
        );
      }
    };
    const agent = createRealtimeAgent(
      this.realtimeService,
      sessionContext,
      waitForTranscript,
    );
    const openAiSession = new OpenAIRealtimeSession(agent, {
      transport,
      model: this.config.model ?? "gpt-realtime",
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
                "Conversación telefónica bilingüe de coordinación logística.",
            },
            turnDetection: {
              type: "semantic_vad",
              eagerness: "medium",
              createResponse: true,
              interruptResponse: true,
            },
          },
          output: { voice: this.config.voice ?? "ash" },
        },
      },
    });

    const callStartedAtMs = Date.now();
    const firstSeenAtByItem = new Map<string, number>();
    let transportClosed = false;
    const closeTransport = async () => {
      if (transportClosed) return;
      transportClosed = true;
      try {
        openAiSession.close();
      } finally {
        await transcriptWriteChain;
      }
      if (
        webSocket.readyState === WebSocket.OPEN ||
        webSocket.readyState === WebSocket.CONNECTING
      ) {
        webSocket.close(1000, "Realtime session closed");
      }
    };
    const unregisterCloser = this.realtimeService.registerConnectionCloser(
      sessionContext.id,
      closeTransport,
    );
    let finalization: Promise<void> | null = null;
    const close = () => {
      finalization ??= (async () => {
        unregisterCloser();
        await closeTransport();
        await this.realtimeService.close(sessionContext.id);
      })();
      return finalization;
    };

    const observe = (item: RealtimeItem, interrupted = false) => {
      const segment = transcriptSegment(
        item,
        callStartedAtMs,
        firstSeenAtByItem,
        interrupted,
      );
      if (segment) {
        transcriptWriteChain = transcriptWriteChain.then(async () => {
          try {
            await this.realtimeService.appendTranscriptSegment(
              sessionContext.id,
              segment,
            );
            transcriptWriteError = null;
          } catch (error) {
            transcriptWriteError = error;
          }
        });
      }
    };

    webSocket.once("close", () => void close());
    webSocket.once("error", () => void close());

    openAiSession.on("transport_event", (event) => {
      if (
        event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped"
      ) {
        const speechEvent = event as any;
        if (speechEvent.type === "input_audio_buffer.speech_started") {
          console.info(
            `[TIMING] caller speech started\\nClock: openai_input\\nItemId: ${speechEvent.item_id}\\nStart: ${speechEvent.audio_start_ms}`,
          );
        } else {
          console.info(
            `[TIMING] caller speech stopped\\nClock: openai_input\\nItemId: ${speechEvent.item_id}\\nEnd: ${speechEvent.audio_end_ms}`,
          );
        }
        return;
      }

      if (event.type !== "twilio_message") return;
      const message = event.message as TwilioMessage;
      if (message.event === "connected") {
        console.info("[TWILIO] connected");
      }
      if (message.event === "start") {
        const providerCallId = message.start?.callSid;
        const streamSid = message.start?.streamSid ?? message.streamSid;
        console.info("[TWILIO] start");
        console.info(`[TWILIO] CallSid: ${providerCallId ?? "unknown"}`);
        console.info(`[TWILIO] StreamSid: ${streamSid ?? "unknown"}`);
      }
      if (message.event === "media" && message.media && message.streamSid) {
        // Here we could track firstMediaLogged if needed
      }
      if (message.event === "stop") {
        console.info("[TWILIO] stop");
        void close();
      }
    });
    openAiSession.on("history_updated", (history) => {
      for (const item of history) observe(item);
    });
    openAiSession.on("audio_interrupted", () => {
      const latestAgentItem = [...openAiSession.history]
        .reverse()
        .find(
          (item) =>
            item.type === "message" &&
            item.role === "assistant" &&
            transcriptText(item) !== null,
        );
      if (latestAgentItem) observe(latestAgentItem, true);
    });
    openAiSession.on("error", () => {
      void close();
      webSocket.close(1011, "OpenAI Realtime error");
    });

    await openAiSession.connect({ apiKey: this.config.apiKey });
  }
}

function captureTwilioStart(
  webSocket: WebSocket,
): Promise<NonNullable<TwilioMessage["start"]>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new ApiError(
          408,
          "TWILIO_START_TIMEOUT",
          "Twilio no envió el evento start dentro del tiempo esperado.",
        ),
      );
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      webSocket.off("message", onMessage);
      webSocket.off("close", onClose);
      webSocket.off("error", onError);
    };
    const onMessage = (data: RawData) => {
      try {
        const message = JSON.parse(data.toString()) as TwilioMessage;
        if (message.event !== "start" || !message.start) return;
        cleanup();
        resolve(message.start);
      } catch {
        // Non-JSON frames cannot be Twilio's start event; the transport owns
        // any subsequent protocol handling.
      }
    };
    const onClose = () => {
      cleanup();
      reject(
        new ApiError(
          409,
          "TWILIO_STREAM_CLOSED",
          "El Media Stream cerró antes de enviar start.",
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    webSocket.on("message", onMessage);
    webSocket.once("close", onClose);
    webSocket.once("error", onError);
  });
}

function createRealtimeAgent(
  service: RealtimeService,
  session: RealtimeSession,
  beforeToolExecution: () => Promise<void>,
): RealtimeAgent {
  const tools = session.allowedTools.map((name) =>
    tool({
      name,
      description: voiceToolDescriptions[name],
      parameters: voiceToolSchemas[name] as z.ZodType<Record<string, unknown>>,
      execute: async (argumentsValue) => {
        await beforeToolExecution();
        return service.executeTool(
          session.id,
          name,
          argumentsValue as Record<string, unknown>,
        );
      },
    }),
  );
  return new RealtimeAgent({
    name: session.agent,
    instructions: instructionsForSession(session),
    tools,
  });
}

function instructionsForSession(session: RealtimeSession): string {
  // Base instructions inspired by relayNegotiatorInstructions
  let instructions = `Eres el agente telefónico ${session.agent} que representa al área de logística para contratar transporte terrestre con transportistas y despachadores.

Operación actual:
- ID: ${session.operationId}
Modo actual: ${session.mode}

Idiomas:
- Habla español mexicano neutral por defecto.
- Si la conversación inició y continúa en español, mantén el español.
- No cambies a inglés por palabras aisladas.
- Cambia completamente a inglés sólo si la otra persona lo pide o lo usa de manera sostenida.
- Si la otra persona vuelve al español, vuelve al español de inmediato.

Estilo:
- Usa respuestas cortas, naturales, directas y profesionales.
- No uses fillers ni frases de chatbot como "déjame pensar", "let me think", "got it".
- No expliques procesos internos, backend, tools, validaciones o razonamiento al transportista.
- Ejemplos naturales: "Perfecto. Entonces son ocho mil quinientos pesos, todo incluido."; "¿Ese precio incluye combustible y maniobras?".

Reglas comerciales:
- Pregunta disponibilidad, precio, fecha y ventana de recolección, y condiciones relevantes.
- Confirma explícitamente números, dinero, fechas y horas ambiguas.
- Puedes negociar sólo dentro del mandato. Nunca puedes ampliarlo ni sustituirlo.
- El límite exacto es privado. Si una cotización resulta demasiado alta, pide una mejora; no reveles el límite.
- La conversación propone acciones; el backend valida y cambia el estado oficial.
- Convierte dinero a unidades menores para la tool: 8,500.00 MXN es 850000.
- Si una tool falla, no afirmes que la acción se completó.`;

  if (session.mode === "QUOTE") {
    instructions += `
- Cada nueva oferta explícita debe registrarse EXACTAMENTE UNA VEZ con evaluateOffer ANTES de responder sobre su elegibilidad.
- También registra ofertas fuera de los rangos. Nunca omitas evaluateOffer porque anticipas que la oferta será inválida: el backend decide elegibilidad.
- No repitas evaluateOffer cuando precio y condiciones no cambiaron.
- Usa BASE_PLUS_FEES sólo cuando el carrier dio tarifa base y cargos. Usa ALL_IN_TOTAL cuando dio un total ALL-IN sin desglose.`;
  }

  return instructions;
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

function transcriptSegment(
  item: RealtimeItem,
  callStartedAtMs: number,
  firstSeenAtByItem: Map<string, number>,
  interrupted: boolean,
): TranscriptSegment | null {
  if (item.type !== "message" || item.role === "system") return null;
  const text = transcriptText(item);
  if (!text) return null;
  const nowOffset = Math.max(0, Date.now() - callStartedAtMs);
  const startMs = firstSeenAtByItem.get(item.itemId) ?? nowOffset;
  firstSeenAtByItem.set(item.itemId, startMs);
  return {
    id: item.itemId,
    speaker: item.role === "user" ? "HUMAN" : "AGENT",
    startMs,
    endMs: Math.max(startMs + 1, nowOffset),
    text,
    final: item.status !== "in_progress",
    interrupted: interrupted || item.status === "incomplete",
  };
}
