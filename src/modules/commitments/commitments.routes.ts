import { Router } from "express";
import { commitmentsController } from "./commitments.controller";
import { asyncHandler } from "../../shared/http/async-handler";

// For /operations/:operationId/commitments
export const commitmentsOperationRouter = Router({ mergeParams: true });
commitmentsOperationRouter.post("/", asyncHandler(commitmentsController.create));

// For /commitments
export const commitmentsRouter = Router({ mergeParams: true });
commitmentsRouter.post("/:commitmentId/confirm", asyncHandler(commitmentsController.confirm));
commitmentsRouter.get("/:commitmentId", asyncHandler(commitmentsController.get));
