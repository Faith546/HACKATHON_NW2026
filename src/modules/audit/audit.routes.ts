import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler";
import { AuditController } from "./audit.controller";
import { AuditService, auditService } from "./audit.service";

export function createAuditOperationRouter(
  service: AuditService = auditService,
): Router {
  const router = Router({ mergeParams: true });
  const controller = new AuditController(service);
  router.get("/", asyncHandler(controller.list));
  return router;
}

export const auditOperationRouter = createAuditOperationRouter();
