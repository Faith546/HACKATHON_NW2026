import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { EscalationsController } from "./escalations.controller";
import {
  escalationsService,
  type EscalationsService,
} from "./escalations.service";

export function createOperationEscalationsRouter(
  service: EscalationsService = escalationsService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new EscalationsController(service);
  router.post("/", asyncHandler(controller.request));
  return router;
}

export function createEscalationsRouter(
  service: EscalationsService = escalationsService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new EscalationsController(service);
  router.get("/:escalationId", asyncHandler(controller.get));
  router.post(
    "/:escalationId/join-human",
    asyncHandler(controller.joinHuman),
  );
  router.post(
    "/:escalationId/resolve",
    asyncHandler(controller.resolve),
  );
  return router;
}

export const escalationsOperationRouter =
  createOperationEscalationsRouter();
export const escalationsRouter = createEscalationsRouter();
