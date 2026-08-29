import type { IncomingMessage, Server } from "node:http";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import {
  RealtimeAgent,
  RealtimeSession as OpenAIRealtimeSession,
  tool,
  type RealtimeItem,
} from "@openai/agents/realtime";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import twilio from "twilio";
import type { CallsService } from "../calls/calls.service";
import type { CallPurpose } from "../calls/calls.types";
import type { VoiceToolName } from "../voice/voice-core.port";
import type { RealtimeService } from "./realtime.service";
import type {
  RealtimeMode,
  RealtimeSession,
  TranscriptSegment,
} from "./realtime.types";

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
    const call = await this.callsService.getById(callId);
    const sessionContext = await this.realtimeService.create({
      callId,
      actorType: "CARRIER",
      carrierId: call.carrierId,
      operationId: call.operationId,
      negotiationId: call.negotiationId,
      mode: modeForPurpose(call.purpose),
    });
    const agent = createRealtimeAgent(this.realtimeService, sessionContext);
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: webSocket,
    });
    const openAiSession = new OpenAIRealtimeSession(agent, {
      transport,
      model: this.config.model ?? "gpt-realtime",
      config: {
        outputModalities: ["audio"],
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
    let providerCallId: string | undefined;
    let closed = false;
    let transcriptWriteChain = Promise.resolve();
    const close = async () => {
      if (closed) return;
      closed = true;
      openAiSession.close();
      await transcriptWriteChain;
      await this.realtimeService.close(sessionContext.id);
    };

    const observe = (item: RealtimeItem, interrupted = false) => {
      const segment = transcriptSegment(
        item,
        callStartedAtMs,
        firstSeenAtByItem,
        interrupted,
      );
      if (segment) {
        transcriptWriteChain = transcriptWriteChain
          .then(() =>
            this.realtimeService.appendTranscriptSegment(
              sessionContext.id,
              segment,
            ),
          )
          .catch(() => undefined);
      }
    };

    webSocket.once("close", () => void close());
    webSocket.once("error", () => void close());

    openAiSession.on("transport_event", (event) => {
      if (event.type !== "twilio_message") return;
      const message = event.message as TwilioMessage;
      if (message.event === "start") {
        providerCallId = message.start?.callSid;
        if (providerCallId) {
          void this.callsService
            .ensureProviderCallId(callId, providerCallId)
            .then(() =>
              this.callsService.applyProviderStatus(
                providerCallId as string,
                "IN_PROGRESS",
              ),
            )
            .catch(() => undefined);
        }
      }
      if (message.event === "stop") void close();
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

function createRealtimeAgent(
  service: RealtimeService,
  session: RealtimeSession,
): RealtimeAgent {
  const tools = session.allowedTools.map((name) =>
    tool({
      name,
      description: toolDescription(name),
      parameters: z.object({}).catchall(z.unknown()),
      execute: async (argumentsValue) =>
        service.executeTool(
          session.id,
          name,
          argumentsValue as Record<string, unknown>,
        ),
    }),
  );
  return new RealtimeAgent({
    name: session.agent,
    instructions: instructionsForSession(session),
    tools,
  });
}

function instructionsForSession(session: RealtimeSession): string {
  return `Eres el agente telefónico ${session.agent} de logística.
Modo actual: ${session.mode}.
Habla en español mexicano neutral y cambia a inglés sólo si la otra persona lo pide o lo usa de manera sostenida.
Usa respuestas cortas, naturales y profesionales.
Nunca inventes IDs, precios, fechas, autorización o resultados de tools.
La conversación propone acciones; el backend valida y cambia el estado oficial.
Nunca reveles límites privados del mandato.
Sólo puedes usar las tools incluidas en esta sesión.
Si una tool falla, no afirmes que la acción se completó.`;
}

function toolDescription(name: VoiceToolName): string {
  return `Ejecuta ${name} en el backend determinista usando exclusivamente hechos explícitos de la conversación.`;
}

function modeForPurpose(purpose: CallPurpose): RealtimeMode {
  if (purpose === "QUOTE" || purpose === "RENEGOTIATION") return "QUOTE";
  if (purpose === "COMMIT") return "COMMIT";
  if (purpose === "INCIDENT" || purpose === "ESCALATION") return "INCIDENT";
  if (purpose === "DELIVERY") return "DELIVERY";
  return "EXECUTION";
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
