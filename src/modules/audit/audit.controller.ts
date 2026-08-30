import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import { AuditService, auditService } from "./audit.service";

function operationIdFrom(request: Request): string {
  const value = request.params.operationId;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "operationId no es válido.",
      { field: "operationId" },
    );
  }
  return value;
}

export class AuditController {
  constructor(private readonly service: AuditService) {}

  list = async (request: Request, response: Response) => {
    const events = await this.service.listAuditEvents(
      operationIdFrom(request),
    );
    response.status(200).json(events);
  };
}

export const auditController = new AuditController(auditService);
