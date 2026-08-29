import { Router } from "express";
import { operationsController } from "./operations.controller";
import { asyncHandler } from "../../shared/http/async-handler";

export const operationsRouter = Router();

operationsRouter.post("/", asyncHandler(operationsController.create));
operationsRouter.get("/:operationId", asyncHandler(operationsController.get));
