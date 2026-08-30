import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { ApiError } from "../../shared/http/api-error";
import { RelayLlmService, relayLlmService } from "./relay-llm.service";
import { RelayLlmChatSchema } from "./relay-llm.types";

export function createRelayLlmRouter(service: RelayLlmService = relayLlmService): Router {
  const router = Router();
  router.post("/chat", asyncHandler(async (request: Request, response: Response) => {
    const parsed = RelayLlmChatSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "La consulta para Raily no es válida.",
        parsed.error.format(),
      );
    }
    response.status(200).json(await service.chat(parsed.data));
  }));
  return router;
}
