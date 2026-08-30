import { Router } from "express";
import { carriersRouter } from "../carriers/carriers.routes";
import { operationsRouter } from "../operations/operations.routes";
import { mandatesRouter } from "../mandates/mandates.routes";
import { campaignsRouter } from "../campaigns/campaigns.routes";
import { negotiationsRouter } from "../negotiations/negotiations.routes";
import { marketNegotiationRouter, marketOperationRouter } from "../market/market.routes";
import { commitmentsOperationRouter, commitmentsRouter } from "../commitments/commitments.routes";
import {
  createCommitmentsOperationRouter,
  createCommitmentsRouter,
} from "../commitments/commitments.routes";
import {
  createOperationIncidentsRouter,
  createIncidentsRouter,
} from "../incidents/incidents.routes";
import {
  createOperationEscalationsRouter,
  createEscalationsRouter,
} from "../escalations/escalations.routes";
import { createExecutionRouter } from "../execution/execution.routes";
import { createAuditOperationRouter } from "../audit/audit.routes";
import type { CommitmentsService } from "../commitments/commitments.service";
import type { IncidentsService } from "../incidents/incidents.service";
import type { EscalationsService } from "../escalations/escalations.service";
import type { ExecutionService } from "../execution/execution.service";
import type { AuditService } from "../audit/audit.service";

export interface CreateCoreRouterOptions {
  commitmentsService?: CommitmentsService;
  incidentsService?: IncidentsService;
  escalationsService?: EscalationsService;
  executionService?: ExecutionService;
  auditService?: AuditService;
}

export function createCoreRouter(
  options: CreateCoreRouterOptions = {},
): Router {
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
  router.use(
    "/operations/:operationId/commitments",
    options.commitmentsService
      ? createCommitmentsOperationRouter(options.commitmentsService)
      : commitmentsOperationRouter,
  );
  router.use("/operations/:operationId", marketOperationRouter);
  router.use(
    "/operations/:operationId/incidents",
    createOperationIncidentsRouter(options.incidentsService),
  );
  router.use(
    "/operations/:operationId/escalations",
    createOperationEscalationsRouter(options.escalationsService),
  );
  router.use(
    "/operations/:operationId/audit-events",
    createAuditOperationRouter(options.auditService),
  );
  router.use(
    "/operations/:operationId",
    createExecutionRouter(options.executionService),
  );
  router.use("/negotiations", negotiationsRouter);
  router.use("/negotiations/:negotiationId", marketNegotiationRouter);
  router.use(
    "/commitments",
    options.commitmentsService
      ? createCommitmentsRouter(options.commitmentsService)
      : commitmentsRouter,
  );
  router.use("/incidents", createIncidentsRouter(options.incidentsService));
  router.use(
    "/escalations",
    createEscalationsRouter(options.escalationsService),
  );

  return router;
}
