import type { Request, Response } from "express";
import { operationsService } from "./operations.service";
import {
  CancelOperationSchema,
  CreateOperationSchema,
  ListOperationsQuerySchema,
} from "./operations.types";
import { ApiError } from "../../shared/http/api-error";

export class OperationsController {
  async create(req: Request, res: Response) {
    const parsed = CreateOperationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de operación inválidos.",
        parsed.error.format(),
      );
    }

    const operation = await operationsService.createOperation(
      parsed.data,
      req.get("x-actor-id") ?? undefined,
    );
    res.status(201).json(operation);
  }

  async list(req: Request, res: Response) {
    const parsed = ListOperationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "El filtro de operaciones es inválido.",
        parsed.error.format(),
      );
    }
    res.status(200).json(
      await operationsService.listOperations(parsed.data.status),
    );
  }

  async get(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    res.status(200).json(await operationsService.getOperation(operationId));
  }

  async getStatus(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    res
      .status(200)
      .json(await operationsService.getOperationStatus(operationId));
  }

  async cancel(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    const parsed = CancelOperationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "El motivo de cancelación es obligatorio.",
        parsed.error.format(),
      );
    }
    res.status(200).json(
      await operationsService.cancelOperation(
        operationId,
        parsed.data,
        req.get("x-actor-id") ?? undefined,
      ),
    );
  }
}

export const operationsController = new OperationsController();
