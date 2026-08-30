import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { WebhooksController } from "./webhooks.controller";
import type { WebhooksService } from "./webhooks.service";

export function createWebhooksRouter(input: {
  service: WebhooksService;
  publicBaseUrl: string;
}): Router {
  const router = Router();
  const controller = new WebhooksController(input.service, input.publicBaseUrl);

  router.post("/webhooks/twilio/voice", asyncHandler(controller.receiveVoice));
  router.post("/webhooks/twilio/status", asyncHandler(controller.receiveStatus));
  return router;
}
