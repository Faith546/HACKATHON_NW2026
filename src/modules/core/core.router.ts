import { Router } from "express";
import { carriersRouter } from "../carriers/carriers.routes";
import { operationsRouter } from "../operations/operations.routes";
import { mandatesRouter } from "../mandates/mandates.routes";
import { campaignsRouter } from "../campaigns/campaigns.routes";
import { negotiationsRouter } from "../negotiations/negotiations.routes";
import { marketNegotiationRouter, marketOperationRouter } from "../market/market.routes";
import { commitmentsOperationRouter, commitmentsRouter } from "../commitments/commitments.routes";

export function createCoreRouter(): Router {
  const router = Router();

  router.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service: "nextwave-voice-logistics-api",
    });
  });

  router.use("/carriers", carriersRouter);
  router.use("/operations", operationsRouter);
  router.use("/operations/:operationId/mandate", mandatesRouter);
  router.use("/operations/:operationId/campaigns", campaignsRouter);
  router.use("/operations/:operationId/commitments", commitmentsOperationRouter);
  router.use("/operations/:operationId", marketOperationRouter);
  router.use("/negotiations", negotiationsRouter);
  router.use("/negotiations/:negotiationId", marketNegotiationRouter);
  router.use("/commitments", commitmentsRouter);

  return router;
}
