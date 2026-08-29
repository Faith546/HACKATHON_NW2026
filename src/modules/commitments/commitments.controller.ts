import type { Request, Response } from "express";
import { commitmentsRepository } from "./commitments.repository";
import { CreateCommitmentSchema, ConfirmCommitmentSchema } from "./commitments.types";
import { ApiError } from "../../shared/http/api-error";

export class CommitmentsController {
  async create(req: Request, res: Response) {
    const { operationId } = req.params;
    
    const parsed = CreateCommitmentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de compromiso inválidos", parsed.error.format());
    }

    const actorId = req.headers["x-actor-id"] as string | undefined;

    const commitment = await commitmentsRepository.createCommitment(operationId, parsed.data, actorId);
    res.status(201).json(commitment);
  }

  async confirm(req: Request, res: Response) {
    const { commitmentId } = req.params;
    
    const parsed = ConfirmCommitmentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de confirmación inválidos", parsed.error.format());
    }

    const actorId = req.headers["x-actor-id"] as string | undefined;

    const commitment = await commitmentsRepository.confirmCommitment(commitmentId, parsed.data, actorId);
    res.status(200).json(commitment);
  }

  async get(req: Request, res: Response) {
    const { commitmentId } = req.params;
    const commitment = await commitmentsRepository.getCommitment(commitmentId);
    
    if (!commitment) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Compromiso no encontrado");
    }

    res.status(200).json(commitment);
  }
}

export const commitmentsController = new CommitmentsController();
