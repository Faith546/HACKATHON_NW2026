import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { CallsController } from "./calls.controller";
import type { CallsService } from "./calls.service";

export function createCallsRouter(service: CallsService): Router {
  const router = Router();
  const controller = new CallsController(service);

  router.post(
    "/operations/:operationId/calls/outbound",
    asyncHandler(controller.enqueueOutbound),
  );
  router.get("/calls/:callId", asyncHandler(controller.getCall));
  router.post("/calls/:callId/brief", asyncHandler(controller.saveBrief));

  return router;
}
