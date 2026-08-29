import type { Request, Response } from "express";
import { mandatesRepository } from "./mandates.repository";
import { CreateMandateVersionSchema } from "./mandates.types";
import { ApiError } from "../../shared/http/api-error";

export class MandatesController {
  async getActive(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    const mandate = await mandatesRepository.getActiveMandate(operationId);
    
    if (!mandate) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "No hay un mandato activo para esta operación");
    }

    res.status(200).json(mandate);
  }

  async createVersion(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    
    const parsed = CreateMandateVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de mandato inválidos", parsed.error.format());
    }

    const newMandate = await mandatesRepository.createMandateVersion(operationId, parsed.data);
    res.status(201).json(newMandate);
  }
}

export const mandatesController = new MandatesController();
