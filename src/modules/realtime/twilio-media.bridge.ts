import type { IncomingMessage, Server } from "node:http";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import {
  RealtimeAgent,
  RealtimeSession as OpenAIRealtimeSession,
  tool,
  type RealtimeItem,
  type RealtimeTransportLayer,
} from "@openai/agents/realtime";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import twilio from "twilio";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";
import type { TimingService } from "../timing/timing.service";
import type { VoiceToolName } from "../voice/voice-core.port";
import {
  voiceToolDescriptions,
  voiceToolParameterSchemas,
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
    private readonly timingService: TimingService,
    private readonly config: TwilioMediaBridgeConfig,
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const match = /^\/ws\/twilio-media\/([^/]+)$/.exec(url.pathname);
      if (!match) return;
      const callId = decodeURIComponent(match[1]);
      console.info(`[TWILIO_MEDIA] upgrade received callId=${callId}`);
      if (!this.hasValidTwilioSignature(request, url.pathname)) {
        console.warn(`[TWILIO_MEDIA] invalid signature callId=${callId}`);
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void this.handleConnection(webSocket, callId).catch((error) => {
          const details = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
          console.error(
            `[TWILIO_MEDIA_BRIDGE_FAILED] callId=${callId} ${details}`,
          );
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
    let identity: { callSid: string; streamSid: string };
    try {
      identity = validateTwilioStartContext(callId, start);
      await this.callsService.ensureStreamIdentity(
        callId,
        identity.callSid,
        identity.streamSid,
      );
    } catch (error) {
      webSocket.close(1008, "Call context mismatch");
      throw error;
    }
    await this.callsService.applyProviderStatus(
      identity.callSid,
      "IN_PROGRESS",
    );
    await this.timingService.record({
      callId,
      streamSid: identity.streamSid,
      clock: "local_observation",
      eventType: "MEDIA_STREAM_ACCEPTED",
      rawTimestampMs: Date.now(),
      metadata: { callSid: identity.callSid },
    });
    const logContext =
      `internalCallId=${callId} callSid=${maskSid(identity.callSid)} ` +
      `streamSid=${maskSid(identity.streamSid)}`;
    console.info(`[VOICE_WS] connected ${logContext}`);
    console.info(`[TWILIO_STREAM] started ${logContext}`);
    const sessionContext = await this.realtimeService.create({
      callId,
      actorType: call.actorType,
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
    let activeAgentContext = sessionContext;
    let openAiSession: OpenAIRealtimeSession;
    const refreshAgentContext = async (toolName: VoiceToolName) => {
      if (toolName !== "getOperationStatus") return;
      const refreshed = await this.realtimeService.getActiveByCallId(callId);
      if (!refreshed) return;
      if (
        refreshed.mode === activeAgentContext.mode &&
        refreshed.operationId === activeAgentContext.operationId &&
        stableToolSet(refreshed.allowedTools) ===
          stableToolSet(activeAgentContext.allowedTools)
      ) {
        return;
      }
      activeAgentContext = refreshed;
      await openAiSession.updateAgent(
        createRealtimeAgent(
          this.realtimeService,
          activeAgentContext,
          waitForTranscript,
          refreshAgentContext,
        ),
      );
    };
    const agent = createRealtimeAgent(
      this.realtimeService,
      activeAgentContext,
      waitForTranscript,
      refreshAgentContext,
    );
    openAiSession = new OpenAIRealtimeSession(agent, {
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
                "Conversación telefónica bilingüe de coordinación logística. Un número de contenedor tiene exactamente cuatro letras seguidas de siete dígitos. Transcribe por separado cada letra y cada dígito, incluidas repeticiones. No completes ni reemplaces caracteres.",
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
    let firstTwilioMediaSeen = false;
    const closeTransport = async () => {
      if (transportClosed) return;
      transportClosed = true;
      try {
        openAiSession.close();
      } finally {
        await transcriptWriteChain;
      }
      if (transcriptWriteError) {
        throw new ApiError(
          503,
          "TRANSCRIPT_PERSISTENCE_FAILED",
          "El último write incremental del transcript no pudo persistirse.",
          {
            callId,
            message:
              transcriptWriteError instanceof Error
                ? transcriptWriteError.message
                : String(transcriptWriteError),
          },
        );
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
        let transportError: unknown = null;
        try {
          await closeTransport();
        } catch (error) {
          transportError = error;
        }
        await this.realtimeService.close(sessionContext.id);
        if (transportError) throw transportError;
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

    const reportCloseFailure = (error: unknown) => {
      console.error("[REALTIME_CLOSE_FAILED]", error);
    };
    const recordTiming = (input: Parameters<TimingService["record"]>[0]) => {
      void this.timingService.record(input).catch((error) => {
        console.error("[TIMING_PERSISTENCE_FAILED]", error);
      });
    };
    webSocket.once("close", () => {
      console.info(`[VOICE_WS] closed ${logContext}`);
      void close().catch(reportCloseFailure);
    });
    webSocket.once("error", () => void close().catch(reportCloseFailure));

    openAiSession.on("transport_event", (event) => {
      if (event.type === "session.created") {
        console.info(`[REALTIME] session_created ${logContext}`);
        return;
      }
      if (event.type === "session.updated") {
        console.info(`[REALTIME] session_updated ${logContext}`);
        return;
      }
      if (
        event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped"
      ) {
        const speechEvent = event as any;
        if (speechEvent.type === "input_audio_buffer.speech_started") {
          recordTiming({
            callId,
            streamSid: identity.streamSid,
            clock: "openai_input",
            eventType: "CALLER_SPEECH_STARTED",
            rawTimestampMs: Number(speechEvent.audio_start_ms),
            itemId: speechEvent.item_id,
          });
          console.info(
            `[REALTIME] caller_speech_started ${logContext} ` +
            `itemId=${speechEvent.item_id} atMs=${speechEvent.audio_start_ms}`,
          );
        } else {
          recordTiming({
            callId,
            streamSid: identity.streamSid,
            clock: "openai_input",
            eventType: "CALLER_SPEECH_STOPPED",
            rawTimestampMs: Number(speechEvent.audio_end_ms),
            itemId: speechEvent.item_id,
          });
          console.info(
            `[REALTIME] caller_speech_stopped ${logContext} ` +
            `itemId=${speechEvent.item_id} atMs=${speechEvent.audio_end_ms}`,
          );
        }
        return;
      }

      if (event.type !== "twilio_message") return;
      const message = event.message as TwilioMessage;
      if (message.event === "media" && message.media && message.streamSid) {
        if (!firstTwilioMediaSeen) {
          firstTwilioMediaSeen = true;
          recordTiming({
            callId,
            streamSid: identity.streamSid,
            clock: "twilio_stream",
            eventType: "FIRST_MEDIA",
            rawTimestampMs: Number(message.media.timestamp ?? 0),
            metadata: { track: message.media.track ?? null },
          });
        }
      }
      if (message.event === "stop") {
        recordTiming({
          callId,
          streamSid: identity.streamSid,
          clock: "local_observation",
          eventType: "MEDIA_STREAM_STOP_OBSERVED",
          rawTimestampMs: Date.now(),
        });
        console.info(`[TWILIO_STREAM] stopped ${logContext}`);
        void close().catch(reportCloseFailure);
      }
    });
    let firstAudioChunkPending = true;
    openAiSession.on("agent_start", () => {
      firstAudioChunkPending = true;
      console.info(`[REALTIME] response_started ${logContext}`);
    });
    openAiSession.on("audio_start", () => {
      console.info(`[REALTIME] assistant_audio_started ${logContext}`);
    });
    openAiSession.on("audio", (event) => {
      if (!firstAudioChunkPending) return;
      firstAudioChunkPending = false;
      console.info(
        `[TWILIO_STREAM] assistant_audio_sent ${logContext} bytes=${event.data.byteLength}`,
      );
    });
    openAiSession.on("agent_end", () => {
      console.info(`[REALTIME] response_done ${logContext}`);
    });
    openAiSession.on("history_updated", (history) => {
      for (const item of history) observe(item);
    });
    openAiSession.on("audio_interrupted", () => {
      console.info(`[REALTIME] audio_interrupted ${logContext}`);
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
    openAiSession.on("error", (event) => {
      console.error(
        `[REALTIME] error ${logContext} ${safeErrorSummary(event.error)}`,
      );
      void close().catch(reportCloseFailure);
      webSocket.close(1011, "OpenAI Realtime error");
    });

    console.info(
      `[REALTIME] connecting ${logContext} ` +
      `model=${this.config.model ?? "gpt-realtime"} voice=${this.config.voice ?? "ash"}`,
    );
    await openAiSession.connect({ apiKey: this.config.apiKey });
    console.info(`[REALTIME] connected ${logContext}`);
    requestInitialAgentResponse(openAiSession.transport);
    console.info(`[REALTIME] initial_response_requested ${logContext}`);
  }
}

export function requestInitialAgentResponse(
  transport: RealtimeTransportLayer,
): void {
  if (transport.requestResponse) {
    transport.requestResponse();
    return;
  }
  transport.sendEvent({ type: "response.create" });
}

export function validateTwilioStartContext(
  expectedCallId: string,
  start: NonNullable<TwilioMessage["start"]>,
): { callSid: string; streamSid: string } {
  if (start.customParameters?.callId !== expectedCallId) {
    throw new ApiError(422, "CALL_CONTEXT_MISMATCH", "El callId del Media Stream no coincide con la ruta firmada.");
  }
  if (!start.callSid) {
    throw new ApiError(422, "CALL_PROVIDER_ID_REQUIRED", "Twilio no incluyó CallSid en el evento start.");
  }
  if (!start.streamSid) {
    throw new ApiError(422, "STREAM_ID_REQUIRED", "Twilio no incluyó StreamSid en el evento start.");
  }
  return { callSid: start.callSid, streamSid: start.streamSid };
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
        resolve({
          ...message.start,
          streamSid: message.start.streamSid ?? message.streamSid,
        });
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
  afterToolExecution: (name: VoiceToolName) => Promise<void>,
): RealtimeAgent {
  const tools = session.allowedTools.map((name) =>
    tool({
      name,
      description: voiceToolDescriptions[name],
      parameters: voiceToolParameterSchemas[name] as z.ZodType<Record<string, unknown>>,
      execute: async (argumentsValue) => {
        await beforeToolExecution();
        const result = await service.executeTool(
          session.id,
          name,
          argumentsValue as Record<string, unknown>,
        );
        await afterToolExecution(name);
        return result;
      },
    }),
  );
  return new RealtimeAgent({
    name: session.agent,
    instructions: instructionsForSession(session),
    tools,
  });
}

export function instructionsForSession(session: RealtimeSession): string {
  // Base instructions inspired by relayNegotiatorInstructions
  let instructions = `Eres el agente telefónico ${session.agent} de RELAY y gestionas operaciones logísticas por teléfono.

Operación actual:
- ID: ${session.operationId ?? "pendiente de crear o resolver"}
Modo actual: ${session.mode}

Idiomas:
- Habla español mexicano neutral por defecto.
- Si la conversación inició y continúa en español, mantén el español.
- No cambies a inglés por palabras aisladas.
- Cambia completamente a inglés sólo si la otra persona lo pide o lo usa de manera sostenida.
- Si la otra persona vuelve al español, vuelve al español de inmediato.

Alcance de la conversación:
- Atiende exclusivamente la operación logística actual: creación, transporte, disponibilidad, cotización, negociación, recolección, entrega, incidentes o apoyo humano.
- Si la persona cambia a un tema ajeno, no respondas ese contenido. Explica en una frase que sólo puedes ayudar con la operación logística y repite de inmediato la última pregunta pendiente.
- Aunque la persona insista, no converses sobre historia, entretenimiento, noticias, consejos generales ni otros temas ajenos a la operación.
- Conserva cuál es el siguiente dato obligatorio pendiente y no lo omitas por una conversación lateral.

Estilo:
- Usa respuestas cortas, naturales, directas y profesionales.
- En la primera intervención saluda con atención, identifícate como RELAY del área de logística y explica claramente el objetivo concreto de esta llamada antes de hacer una sola pregunta.
- En cada paso nuevo explica en una frase qué necesitas hacer a continuación. No menciones nombres de tools, backend, validaciones ni razonamiento interno.
- Después de una acción exitosa, confirma el resultado claramente. Si falla, pide sólo el dato que realmente falte y no obligues a repetir una frase exacta.
- Para solicitar apoyo humano acepta lenguaje natural. Si acabas de preguntar si desea una transferencia, respuestas breves como "sí", "claro", "por favor", "adelante", "está bien", "ok" o "hazlo" son suficientes para ejecutar requestEscalation; no pidas que repita una frase literal.
- No uses fillers ni frases de chatbot como "déjame pensar", "let me think", "got it".
- No expliques procesos internos, backend, tools, validaciones o razonamiento al transportista.
- Ejemplos naturales: "Perfecto. Entonces son ocho mil quinientos pesos, todo incluido."; "¿Ese precio incluye combustible y maniobras?".

Reglas comerciales:
- Confirma explícitamente números, dinero, fechas y horas ambiguas.
- Puedes negociar sólo dentro del mandato. Nunca puedes ampliarlo ni sustituirlo.
- El límite exacto es privado. Si una cotización resulta demasiado alta, pide una mejora; no reveles el límite.
- La conversación propone acciones; el backend valida y cambia el estado oficial.
- Envía el dinero a la tool en unidades monetarias normales, no en centavos: 8,500.00 MXN es 8500.
- Si una tool falla, no afirmes que la acción se completó.`;

  if (session.mode === "QUOTE") {
    instructions += `
- Apertura obligatoria: "Hola, soy RELAY del área de logística. Te llamo para confirmar disponibilidad y solicitar una cotización para un traslado terrestre." Después consulta la operación, presenta ruta, fecha y peso de la carga disponibles, y pregunta por disponibilidad, precio total, ventana de recolección y condiciones relevantes.
- Cada nueva oferta explícita debe registrarse EXACTAMENTE UNA VEZ con evaluateOffer ANTES de responder sobre su elegibilidad.
- También registra ofertas fuera de los rangos. Nunca omitas evaluateOffer porque anticipas que la oferta será inválida: el backend decide elegibilidad.
- No repitas evaluateOffer cuando precio y condiciones no cambiaron.
- Si evaluateOffer devuelve PRICE_EXCEEDS_MANDATE, NO uses recordQuote: pide una mejora concreta sin revelar el límite, escucha la nueva oferta completa y vuelve a ejecutar evaluateOffer con el nuevo precio.
- Usa recordQuote únicamente después de que evaluateOffer permita la oferta final; no guardes como cotización final una oferta rechazada.
- Si el carrier pide hablar con una persona, ejecuta requestEscalation de inmediato con reason HUMAN_REQUESTED y un resumen breve. No cuelgues ni prometas que ya se unió: informa que iniciarás la transferencia.
- Cuando precio, pickup y condiciones sean finales y permitidos, usa recordQuote sin solicitar ni inventar una vigencia; el backend le asigna 24 horas automáticamente.
- Envía el precio total acordado en totalPrice. Si el carrier dio tarifa base, cargos o un total ALL-IN, conserva ese desglose únicamente en notes.`;
  }

  if (session.mode === "OPERATIONS") {
    instructions += `
- Apertura obligatoria: "Hola, soy RELAY, asistente automatizado del área de logística. Puedo ayudarte a crear una operación nueva o consultar una existente. ¿Qué necesitas hacer?"
- La identidad telefónica ya fue validada como operador interno autorizado.
- Identifícate claramente como agente automatizado.
- Para crear una operación, recopila obligatoriamente cliente, número de contenedor, origen, destino, PESO de la carga, fecha de pickup, precio máximo y moneda. El contenedor debe quedar exactamente como cuatro letras y siete dígitos. Si faltan o sobran caracteres, no crees la operación: vuelve a pedirlo carácter por carácter, incluidas las repeticiones. Pregunta de forma explícita: "¿Cuál es el peso aproximado de la carga en kilogramos?" Nunca supongas ni uses un peso por defecto.
- Si el operador da toneladas, convierte a kilogramos y confirma la conversión antes de continuar.
- Recapitula todos los hechos, incluido el peso. Ejecuta createOperation una sola vez después de una confirmación natural como "sí", "correcto", "de acuerdo" o "queda confirmado"; no exijas una frase literal.
- createOperation inicia automáticamente la campaña con los tres carriers activos; no llames startCampaign después de un createOperation exitoso.
- Para consultar o cerrar una operación existente, exige primero operationId o containerNumber y usa getOperationStatus para vincular esta llamada a esa operación exacta.
- Antes de crear o consultar por containerNumber, repítelo carácter por carácter: las cuatro letras y los siete dígitos, incluidas las repeticiones. Espera la confirmación del operador y envía todos los caracteres confirmados, sin completar ni recortar ninguno.
- Si el operador niega, corrige o dice que no mencionó el número repetido, descarta por completo ese valor. Pide primero las cuatro letras y después los siete dígitos; no intentes corregirlo por tu cuenta y no ejecutes ninguna acción hasta recibir una nueva confirmación afirmativa.
- Si getOperationStatus devuelve found=false y possibleContainerNumbers, lee la sugerencia completa carácter por carácter y pide confirmación. Consulta de nuevo sólo con el número que el operador confirme. Nunca selecciones automáticamente una coincidencia aproximada.
- Si getOperationStatus devuelve found=false sin sugerencias, pide nuevamente las cuatro letras y los siete dígitos; no afirmes que la operación no existe hasta verificar el número completo.
- Cuando getOperationStatus encuentre la operación, usa status, activeCampaign y quotes para explicar qué obtuvieron las llamadas: quién cotizó, precio, moneda y fecha. Si aún hay llamadas activas, aclara que los resultados todavía pueden cambiar.
- En este modo no puedes cerrar una operación. Si getOperationStatus resuelve una operación IN_TRANSIT, la sesión cambia de forma controlada al modo DELIVERY.`;
  }

  if (session.mode === "DELIVERY") {
    instructions += `
- Apertura obligatoria: "Hola, soy RELAY del área de logística. Esta llamada es para confirmar si la entrega de la operación ya ocurrió y registrar sus datos. ¿La carga ya fue entregada?"
- La llamada ya fue vinculada por el backend a una operación IN_TRANSIT exacta.
- Consulta getOperation antes de cerrar y comunica al carrier la dirección de destino oficial. Pregunta si confirma que la entrega ya ocurrió exactamente en esa dirección.
- Una intención administrativa de cerrar, una ETA o frases como "debería haber llegado" no prueban entrega.
- Solicita fecha, hora, identidad del confirmante y condición de la carga; repite todos esos hechos.
- Acepta expresiones naturales de entrega ocurrida como "ya llegó", "fue entregada", "la recibimos" o una respuesta afirmativa a tu pregunta de confirmación; no exijas la palabra "confirmo".
- Ejecuta confirmDelivery con deliveryAddress igual a la dirección oficial consultada únicamente después de que el carrier confirme entrega y dirección. Si la dirección no coincide o la entrega es futura o dudosa, no completes la operación ni solicites intervención humana automáticamente: aclara los datos con el carrier.`;
  }

  if (session.mode === "COMMIT") {
    instructions += `
- Antes de hablar de los términos, consulta getAuthorizedCommitment y getOperation para usar exclusivamente los datos oficiales.
- Apertura obligatoria: "Hola, soy RELAY del área de logística. Te llamo para informarte que tu cotización fue seleccionada como ganadora y confirmar contigo los términos para formalizar la operación."
- Informa claramente al carrier que ganó. Recapitula contenedor, ruta, pickup, precio y moneda oficiales, y pregunta: "¿Confirmas que aceptas estos términos?"
- No vuelvas a pedir disponibilidad ni una nueva cotización. Sólo corrige términos si el carrier señala una diferencia.
- Acepta lenguaje afirmativo natural como "sí", "queda confirmado", "de acuerdo", "correcto" o "acepto". No exijas la frase literal "sí, acepto".
- Cuando el carrier confirme, ejecuta recordVerbalAgreement una sola vez con un objeto vacío. El runtime deriva los datos auditables y guarda la evidencia de la última intervención humana.`;
  }

  if (session.mode === "INCIDENT") {
    instructions += `
- Apertura obligatoria: "Hola, soy RELAY del área de logística. Esta llamada es para registrar la incidencia de la operación y revisar cómo proceder. ¿Qué ocurrió?"
- Explica brevemente cuándo vas a registrar el incidente, evaluar el cambio o solicitar apoyo humano.`;
  }

  if (session.mode === "EXECUTION") {
    instructions += `
- Apertura obligatoria: "Hola, soy RELAY del área de logística. Esta llamada es para dar seguimiento a la recolección y registrar el estado actual de la operación. ¿La carga ya fue recolectada?"
- Después de reportIncident, ejecuta evaluateIncidentChange con el incidentId devuelto antes de afirmar si el cambio está permitido.
- Si la evaluación no lo permite, no modifiques términos y solicita escalación con el mismo incidentId.`;
  }

  return instructions;
}

function stableToolSet(tools: VoiceToolName[]): string {
  return [...tools].sort().join(",");
}

function maskSid(value: string): string {
  return `***${value.slice(-4)}`;
}

function safeErrorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "Unknown Realtime error";
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
  const source = transcriptSource(item);
  const text = source === "CALLER_AUDIO"
    ? item.content
        .map((content) => "transcript" in content ? content.transcript : null)
        .filter((value): value is string => Boolean(value?.trim()))
        .join(" ")
        .trim()
    : transcriptText(item);
  if (!text) return null;
  const nowOffset = Math.max(0, Date.now() - callStartedAtMs);
  const startMs = firstSeenAtByItem.get(item.itemId) ?? nowOffset;
  firstSeenAtByItem.set(item.itemId, startMs);
  return {
    id: item.itemId,
    speaker: item.role === "user" ? "HUMAN" : "AGENT",
    source,
    startMs,
    endMs: Math.max(startMs + 1, nowOffset),
    text,
    final: item.status !== "in_progress",
    interrupted: interrupted || item.status === "incomplete",
  };
}

function transcriptSource(
  item: RealtimeItem,
): TranscriptSegment["source"] {
  if (item.type !== "message" || item.role === "system") {
    return "PROGRAMMATIC_TEXT";
  }
  if (item.role === "assistant") return "AGENT_AUDIO";
  return item.content.some(
    (content) => "transcript" in content && Boolean(content.transcript?.trim()),
  )
    ? "CALLER_AUDIO"
    : "PROGRAMMATIC_TEXT";
}
