import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { RealtimeService } from "./realtime.service";
import {
  realtimeActorTypes,
  realtimeModes,
  toRealtimeSessionResponse,
  type CreateRealtimeSessionInput,
} from "./realtime.types";

function parseCreateRequest(value: unknown): CreateRealtimeSessionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", "El cuerpo es obligatorio.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.callId !== "string" || body.callId.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", "callId es obligatorio.");
  }
  if (
    typeof body.actorType !== "string" ||
    !realtimeActorTypes.includes(body.actorType as CreateRealtimeSessionInput["actorType"])
  ) {
    throw new ApiError(422, "VALIDATION_ERROR", "actorType no es válido.");
  }
  if (
    typeof body.mode !== "string" ||
    !realtimeModes.includes(body.mode as CreateRealtimeSessionInput["mode"])
  ) {
    throw new ApiError(422, "VALIDATION_ERROR", "mode no es válido.");
  }
  for (const field of ["carrierId", "operationId", "negotiationId"] as const) {
    if (
      body[field] !== undefined &&
      body[field] !== null &&
      typeof body[field] !== "string"
    ) {
      throw new ApiError(422, "VALIDATION_ERROR", `${field} debe ser texto o null.`);
    }
  }
  return {
    callId: body.callId,
    actorType: body.actorType as CreateRealtimeSessionInput["actorType"],
    mode: body.mode as CreateRealtimeSessionInput["mode"],
    carrierId: body.carrierId as string | null | undefined,
    operationId: body.operationId as string | null | undefined,
    negotiationId: body.negotiationId as string | null | undefined,
  };
}

function routeParameter(value: string | string[]): string {
  if (Array.isArray(value) || value.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", "sessionId no es válido.");
  }
  return value;
}

export class RealtimeController {
  constructor(private readonly service: RealtimeService) {}

  create = async (request: Request, response: Response) => {
    const session = await this.service.create(parseCreateRequest(request.body));
    response.status(201).json(toRealtimeSessionResponse(session));
  };

  close = async (request: Request, response: Response) => {
    await this.service.close(routeParameter(request.params.sessionId));
    response.status(204).send();
  };
}
