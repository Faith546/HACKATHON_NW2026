import { Router } from "express";
import { campaignsController } from "./campaigns.controller";
import { asyncHandler } from "../../shared/http/async-handler";

export const campaignsRouter = Router({ mergeParams: true });

campaignsRouter.post("/", asyncHandler(campaignsController.create));
campaignsRouter.get("/:campaignId", asyncHandler(campaignsController.get));
