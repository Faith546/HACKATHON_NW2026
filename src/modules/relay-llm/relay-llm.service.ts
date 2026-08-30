import OpenAI from "openai";
import { ApiError } from "../../shared/http/api-error";
import {
  RELAY_OUT_OF_SCOPE_REPLY,
  type RelayLlmChatInput,
  type RelayLlmProvider,
  type RelayOperationalContextRepository,
} from "./relay-llm.types";
import { relayOperationalContextRepository } from "./relay-llm.repository";

const RAILY_INSTRUCTIONS = `Eres Raily, el asistente conversacional de Relay.
Responde únicamente sobre Relay y su operación logística: mandatorios, transportistas, cotizaciones, entregas, retrasos, emergencias, llamadas, compromisos y calendario operativo.
Usa exclusivamente el contexto operativo proporcionado. No inventes datos, precios, estados ni acciones. Esta es una experiencia de consulta: no crees, modifiques ni ejecutes acciones.
Si faltan datos, dilo claramente. Si la consulta está fuera del dominio de Relay/logística, responde exactamente: “Puedo ayudarte únicamente con la operación logística de Relay.”
Responde en español, de forma breve y clara.`;

const OUT_OF_SCOPE_PATTERNS = [
  /\b(capital|receta|clima|pel[ií]cula|m[uú]sica|poema|chiste|pol[ií]tica|elecci[oó]n|programa|c[oó]digo|traduce|traducci[oó]n|finanzas personales)\b/i,
];

export class OpenAiRelayLlmProvider implements RelayLlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.CHAT_FRONTEND_MODEL?.trim() || "gpt-4.1-mini",
  ) {}

  async reply(input: { message: string; operationalContext: string }): Promise<string> {
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.responses.create({
      model: this.model,
      instructions: RAILY_INSTRUCTIONS,
      input: `Contexto operativo interno (no proviene del frontend):\n${input.operationalContext}\n\nPregunta del usuario:\n${input.message}`,
      max_output_tokens: 300,
    });
    return response.output_text.trim() || "No tengo datos suficientes para responder esa consulta.";
  }
}

export class RelayLlmService {
  constructor(
    private readonly contextRepository: RelayOperationalContextRepository = relayOperationalContextRepository,
    private readonly providerFactory: () => RelayLlmProvider = createOpenAiProvider,
  ) {}

  async chat(input: RelayLlmChatInput): Promise<{ reply: string; inScope: boolean }> {
    if (!isRelayLogisticsQuestion(input.message)) {
      return { reply: RELAY_OUT_OF_SCOPE_REPLY, inScope: false };
    }

    const operationalContext = await this.contextRepository.getContext(input.operationId);
    try {
      const reply = await this.providerFactory().reply({
        message: input.message,
        operationalContext,
      });
      return { reply, inScope: true };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        502,
        "LLM_PROVIDER_ERROR",
        "El asistente no está disponible temporalmente.",
      );
    }
  }
}

function createOpenAiProvider(): RelayLlmProvider {
  const apiKey = process.env.CHAT_FRONTEND_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "LLM_NOT_CONFIGURED",
      "El asistente no está configurado en este entorno.",
    );
  }
  return new OpenAiRelayLlmProvider(apiKey);
}

function isRelayLogisticsQuestion(message: string): boolean {
  return !OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(message));
}

export const relayLlmService = new RelayLlmService();
