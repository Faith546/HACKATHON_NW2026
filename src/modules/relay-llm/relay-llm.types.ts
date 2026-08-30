import { z } from "zod";

export const RELAY_OUT_OF_SCOPE_REPLY =
  "Puedo ayudarte únicamente con la operación logística de Relay.";

export const RelayLlmChatSchema = z
  .object({
    message: z.string().trim().min(1).max(2_000),
    conversationId: z.string().trim().min(1).max(128).optional(),
    operationId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type RelayLlmChatInput = z.infer<typeof RelayLlmChatSchema>;

export interface RelayOperationalContextRepository {
  getContext(operationId?: string): Promise<string>;
}

export interface RelayLlmProvider {
  reply(input: { message: string; operationalContext: string }): Promise<string>;
}
