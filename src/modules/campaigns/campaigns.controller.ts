import type { Request, Response } from "express";
import { campaignsRepository } from "./campaigns.repository";
import { CreateCampaignSchema } from "./campaigns.types";
import { ApiError } from "../../shared/http/api-error";

export class CampaignsController {
  async create(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    
    const parsed = CreateCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de campaña inválidos", parsed.error.format());
    }

    const { campaign, negotiations } = await campaignsRepository.createCampaign(operationId, parsed.data);
    
    res.status(202).json({
      ...campaign,
      negotiations,
    });
  }

  async get(req: Request, res: Response) {
    const campaignId = req.params.campaignId as string;
    const campaign = await campaignsRepository.getCampaignById(campaignId);
    
    if (!campaign) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Campaña no encontrada");
    }

    res.status(200).json(campaign);
  }
}

export const campaignsController = new CampaignsController();
