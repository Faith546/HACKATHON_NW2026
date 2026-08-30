import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { ExecutionController } from "./execution.controller";
import {
  executionService,
  type ExecutionService,
} from "./execution.service";

export function createExecutionRouter(
  service: ExecutionService = executionService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new ExecutionController(service);
  router.post("/pickup/confirm", asyncHandler(controller.confirmPickup));
  router.post("/delivery/confirm", asyncHandler(controller.confirmDelivery));
  return router;
}

export const executionRouter = createExecutionRouter();
