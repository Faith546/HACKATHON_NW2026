import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { IncidentsController } from "./incidents.controller";
import {
  incidentsService,
  type IncidentsService,
} from "./incidents.service";

export function createOperationIncidentsRouter(
  service: IncidentsService = incidentsService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new IncidentsController(service);
  router.post("/", asyncHandler(controller.report));
  return router;
}

export function createIncidentsRouter(
  service: IncidentsService = incidentsService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new IncidentsController(service);
  router.post(
    "/:incidentId/evaluate-change",
    asyncHandler(controller.evaluateChange),
  );
  return router;
}

export const incidentsOperationRouter = createOperationIncidentsRouter();
export const incidentsRouter = createIncidentsRouter();
