import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { IncidentsService } from "./incidents.service";
import {
  EvaluateChangeSchema,
  ReportIncidentSchema,
} from "./incidents.types";

export class IncidentsController {
  constructor(private readonly service: IncidentsService) {}

  report = async (request: Request, response: Response): Promise<void> => {
    const parsed = ReportIncidentSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Los datos de la incidencia no son válidos.",
        parsed.error.format(),
      );
    }

    const incident = this.service.reportIncident(
      String(request.params.operationId),
      parsed.data,
      actorIdFrom(request),
    );
    response.status(201).json(toIncidentResponse(incident));
  };

  evaluateChange = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const parsed = EvaluateChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "El cambio propuesto no puede evaluarse.",
        parsed.error.format(),
      );
    }

    const result = this.service.evaluateChange(
      String(request.params.incidentId),
      parsed.data,
      actorIdFrom(request),
    );
    response.status(200).json(result);
  };
}

function actorIdFrom(request: Request): string | undefined {
  const value = request.headers["x-actor-id"];
  return Array.isArray(value) ? value[0] : value;
}

function toIncidentResponse(
  incident: ReturnType<IncidentsService["reportIncident"]>,
) {
  return {
    id: incident.id,
    operationId: incident.operationId,
    callId: incident.callId,
    type: incident.type,
    description: incident.description,
    ...(incident.reportedBy === null
      ? {}
      : { reportedBy: incident.reportedBy }),
    status: incident.status,
    evaluationCode: incident.evaluationCode,
    createdAt: incident.createdAt,
  };
}
