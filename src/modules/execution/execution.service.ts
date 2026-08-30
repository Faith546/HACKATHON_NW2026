import { db } from "../../db";
import {
  ExecutionRepository,
  type ExecutionDatabase,
  type ExecutionRepositoryOptions,
} from "./execution.repository";
import type {
  ConfirmDeliveryInput,
  ConfirmExecutionEventInput,
  OperationExecutionResponse,
} from "./execution.types";

export class ExecutionService {
  constructor(private readonly repository: ExecutionRepository) {}

  confirmPickup(
    operationId: string,
    input: ConfirmExecutionEventInput,
    actorId?: string,
    actorType: "DRIVER" | "INTERNAL_OPERATOR" = "DRIVER",
  ): OperationExecutionResponse {
    return this.repository.confirmPickup(
      operationId,
      input,
      actorId,
      actorType,
    );
  }

  confirmDelivery(
    operationId: string,
    input: ConfirmDeliveryInput,
    actorId?: string,
    actorType: "DRIVER" | "INTERNAL_OPERATOR" = "DRIVER",
  ): OperationExecutionResponse {
    return this.repository.confirmDelivery(
      operationId,
      input,
      actorId,
      actorType,
    );
  }
}

export interface CreateExecutionServiceOptions
  extends ExecutionRepositoryOptions {
  database?: ExecutionDatabase;
}

export function createExecutionService(
  options: CreateExecutionServiceOptions = {},
): ExecutionService {
  const { database = db, ...repositoryOptions } = options;
  return new ExecutionService(
    new ExecutionRepository(database, repositoryOptions),
  );
}

export const executionService = createExecutionService();
