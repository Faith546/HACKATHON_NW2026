import { Router } from "express";
import { marketController } from "./market.controller";
import { asyncHandler } from "../../shared/http/async-handler";

export const marketNegotiationRouter = Router({ mergeParams: true });
export const marketOperationRouter = Router({ mergeParams: true });

// Mounted under /negotiations/:negotiationId
marketNegotiationRouter.post("/offers/evaluate", asyncHandler(marketController.evaluate));
marketNegotiationRouter.post("/quotes", asyncHandler(marketController.save));

// Mounted under /operations/:operationId
marketOperationRouter.get("/quotes", asyncHandler(marketController.getQuotes));
marketOperationRouter.post("/market/selection", asyncHandler(marketController.selectQuote));
