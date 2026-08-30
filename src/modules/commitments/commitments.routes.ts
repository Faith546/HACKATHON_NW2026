import { Router } from "express";
import { CommitmentsController } from "./commitments.controller";
import { asyncHandler } from "../../shared/http/async-handler";
import {
  CommitmentsService,
  commitmentsService,
} from "./commitments.service";

export function createCommitmentsOperationRouter(
  service: CommitmentsService = commitmentsService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new CommitmentsController(service);
  router.post("/authorize", asyncHandler(controller.authorize));
  router.get("/", asyncHandler(controller.list));
  return router;
}

export function createCommitmentsRouter(
  service: CommitmentsService = commitmentsService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new CommitmentsController(service);
  router.post(
    "/:commitmentId/verbal-agreement",
    asyncHandler(controller.recordVerbalAgreement),
  );
  router.post(
    "/:commitmentId/evidence",
    asyncHandler(controller.attachEvidence),
  );
  router.post(
    "/:commitmentId/summary",
    asyncHandler(controller.enqueueSummary),
  );
  return router;
}

export const commitmentsOperationRouter =
  createCommitmentsOperationRouter();
export const commitmentsRouter = createCommitmentsRouter();
