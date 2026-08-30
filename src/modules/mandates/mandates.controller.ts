import type { Request, Response } from "express";
import { mandatesService } from "./mandates.service";
import { CreateMandateVersionSchema } from "./mandates.types";
import { ApiError } from "../../shared/http/api-error";

export class MandatesController {
  async getActive(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    res.status(200).json(await mandatesService.getActiveMandate(operationId));
  }

  async createVersion(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    
    const parsed = CreateMandateVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de mandato inválidos.",
        parsed.error.format(),
      );
    }

    const newMandate = await mandatesService.createMandateVersion(
      operationId,
      parsed.data,
      req.get("x-actor-id") ?? undefined,
    );
    res.status(201).json(newMandate);
  }
}

export const mandatesController = new MandatesController();
