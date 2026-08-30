import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { ExecutionService } from "./execution.service";
import {
  ConfirmDeliverySchema,
  ConfirmExecutionEventSchema,
} from "./execution.types";

export class ExecutionController {
  constructor(private readonly service: ExecutionService) {}

  confirmPickup = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const input = parseInput(request, ConfirmExecutionEventSchema);
    const operation = this.service.confirmPickup(
      String(request.params.operationId),
      input,
      actorIdFrom(request),
    );
    response.status(200).json(operation);
  };

  confirmDelivery = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const input = parseInput(request, ConfirmDeliverySchema);
    const operation = this.service.confirmDelivery(
      String(request.params.operationId),
      input,
      actorIdFrom(request),
    );
    response.status(200).json(operation);
  };
}

function parseInput<T>(
  request: Request,
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { format(): unknown } };
  },
): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "El evento de ejecución no es válido.",
      parsed.error.format() as Record<string, unknown>,
    );
  }
  return parsed.data;
}

function actorIdFrom(request: Request): string | undefined {
  const value = request.headers["x-actor-id"];
  return Array.isArray(value) ? value[0] : value;
}
