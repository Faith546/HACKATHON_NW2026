import type { Request, Response } from "express";
import { negotiationsRepository } from "./negotiations.repository";
import { ApiError } from "../../shared/http/api-error";

export class NegotiationsController {
  async get(req: Request, res: Response) {
    const negotiationId = req.params.negotiationId as string;
    const negotiation = await negotiationsRepository.getNegotiationById(negotiationId);
    
    if (!negotiation) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Negociación no encontrada");
    }

    res.status(200).json(negotiation);
  }
}

export const negotiationsController = new NegotiationsController();
