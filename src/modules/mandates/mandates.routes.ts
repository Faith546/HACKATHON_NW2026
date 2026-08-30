import { Router } from "express";
import { mandatesController } from "./mandates.controller";
import { asyncHandler } from "../../shared/http/async-handler";

export const mandatesRouter = Router({ mergeParams: true });

mandatesRouter.get("/", asyncHandler(mandatesController.getActive));
mandatesRouter.post("/versions", asyncHandler(mandatesController.createVersion));
