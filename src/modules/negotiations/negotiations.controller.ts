import type { Request, Response } from "express";
import { negotiationsService } from "./negotiations.service";

export class NegotiationsController {
  async get(req: Request, res: Response) {
    const negotiationId = req.params.negotiationId as string;
    res
      .status(200)
      .json(await negotiationsService.getNegotiation(negotiationId));
  }
}

export const negotiationsController = new NegotiationsController();
