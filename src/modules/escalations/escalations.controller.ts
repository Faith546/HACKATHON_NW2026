import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { EscalationsService } from "./escalations.service";
import {
  JoinHumanSchema,
  RequestEscalationSchema,
  ResolveEscalationSchema,
} from "./escalations.types";

export class EscalationsController {
  constructor(private readonly service: EscalationsService) {}

  request = async (request: Request, response: Response): Promise<void> => {
    const parsed = RequestEscalationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Los datos de la escalación no son válidos.",
        parsed.error.format(),
      );
    }

    const escalation = this.service.requestEscalation(
      String(request.params.operationId),
      parsed.data,
      actorIdFrom(request),
    );
    response.status(201).json(escalation);
  };

  joinHuman = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const parsed = JoinHumanSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "El teléfono del humano no es válido.",
        parsed.error.format(),
      );
    }

    const escalation = this.service.joinHuman(
      String(request.params.escalationId),
      parsed.data,
      actorIdFrom(request),
    );
    response.status(202).json(escalation);
  };

  get = async (request: Request, response: Response): Promise<void> => {
    const escalation = this.service.getEscalation(
      String(request.params.escalationId),
    );
    if (!escalation) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "La escalación no existe.");
    }
    response.status(200).json(escalation);
  };

  resolve = async (request: Request, response: Response): Promise<void> => {
    const parsed = ResolveEscalationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "La resolución de la escalación no es válida.",
        parsed.error.format(),
      );
    }
    const escalation = this.service.resolveEscalation(
      String(request.params.escalationId),
      parsed.data,
      actorIdFrom(request),
    );
    response.status(200).json(escalation);
  };
}

function actorIdFrom(request: Request): string | undefined {
  const value = request.headers["x-actor-id"];
  return Array.isArray(value) ? value[0] : value;
}
