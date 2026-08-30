import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { EscalationsService } from "./escalations.service";
import {
  JoinHumanSchema,
  RequestEscalationSchema,
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
}

function actorIdFrom(request: Request): string | undefined {
  const value = request.headers["x-actor-id"];
  return Array.isArray(value) ? value[0] : value;
}
