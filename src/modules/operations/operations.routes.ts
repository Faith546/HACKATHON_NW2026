import { Router } from "express";
import { operationsController } from "./operations.controller";
import { asyncHandler } from "../../shared/http/async-handler";
import { mandatesController } from "../mandates/mandates.controller";

export const operationsRouter = Router();

operationsRouter.post("/", asyncHandler(operationsController.create));
operationsRouter.get("/", asyncHandler(operationsController.list));
operationsRouter.get(
  "/:operationId/status",
  asyncHandler(operationsController.getStatus),
);
operationsRouter.post(
  "/:operationId/cancel",
  asyncHandler(operationsController.cancel),
);
// The canonical OpenAPI path is plural. The legacy singular mount remains in
// core.router for compatibility, but all new callers use this route.
operationsRouter.post(
  "/:operationId/mandates/versions",
  asyncHandler(mandatesController.createVersion),
);
operationsRouter.get("/:operationId", asyncHandler(operationsController.get));
