import type { Request, Response } from "express";
import { campaignsService } from "./campaigns.service";
import { CreateCampaignSchema } from "./campaigns.types";
import { ApiError } from "../../shared/http/api-error";

export class CampaignsController {
  async create(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    
    const parsed = CreateCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de campaña inválidos.",
        parsed.error.format(),
      );
    }

    res.status(202).json(
      await campaignsService.startCampaign(
        operationId,
        parsed.data,
        req.get("x-actor-id") ?? undefined,
      ),
    );
  }

  async get(req: Request, res: Response) {
    const campaignId = req.params.campaignId as string;
    const operationId = req.params.operationId as string;
    res
      .status(200)
      .json(await campaignsService.getCampaign(operationId, campaignId));
  }
}

export const campaignsController = new CampaignsController();
