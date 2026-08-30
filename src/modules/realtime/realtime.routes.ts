import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { RealtimeController } from "./realtime.controller";
import type { RealtimeService } from "./realtime.service";

export function createRealtimeRouter(service: RealtimeService): Router {
  const router = Router();
  const controller = new RealtimeController(service);
  router.post("/realtime/sessions", asyncHandler(controller.create));
  router.delete("/realtime/sessions/:sessionId", asyncHandler(controller.close));
  return router;
}
