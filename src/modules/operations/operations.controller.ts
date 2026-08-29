import type { Request, Response } from "express";
import { operationsRepository } from "./operations.repository";
import { CreateOperationSchema } from "./operations.types";
import { ApiError } from "../../shared/http/api-error";

export class OperationsController {
  async create(req: Request, res: Response) {
    const parsed = CreateOperationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de operación inválidos", parsed.error.format());
    }

    const { operation, mandate } = await operationsRepository.createOperationWithMandate(parsed.data);
    
    // El openapi original especificaba devolver todo junto en un solo objeto para simplificar en v1
    res.status(201).json({
      ...operation,
      mandate,
    });
  }

  async get(req: Request, res: Response) {
    const { operationId } = req.params;
    const operation = await operationsRepository.findOperationById(operationId);
    
    if (!operation) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operación no encontrada");
    }

    res.status(200).json(operation);
  }
}

export const operationsController = new OperationsController();
