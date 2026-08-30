import { Router } from "express";
import { negotiationsController } from "./negotiations.controller";
import { asyncHandler } from "../../shared/http/async-handler";

export const negotiationsRouter = Router();

negotiationsRouter.get("/:negotiationId", asyncHandler(negotiationsController.get));
