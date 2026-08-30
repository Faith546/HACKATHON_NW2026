import type { Request, Response } from "express";
import { marketService } from "./market.service";
import { EvaluateQuoteSchema, SaveQuoteSchema, SelectQuoteSchema } from "./market.types";
import { ApiError } from "../../shared/http/api-error";

export class MarketController {
  async evaluate(req: Request, res: Response) {
    const negotiationId = req.params.negotiationId as string;
    
    const parsed = EvaluateQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de evaluación inválidos.",
        parsed.error.format(),
      );
    }

    const evaluation = await marketService.evaluateOffer(
      negotiationId,
      parsed.data,
      req.get("x-actor-id") ?? undefined,
    );
    res.status(200).json(evaluation);
  }

  async save(req: Request, res: Response) {
    const negotiationId = req.params.negotiationId as string;
    
    const parsed = SaveQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de cotización inválidos.",
        parsed.error.format(),
      );
    }

    // Usaremos un actor genérico de IA por defecto a menos que se mande en los headers
    const quote = await marketService.recordQuote(
      negotiationId,
      parsed.data,
      req.get("x-actor-id") ?? undefined,
    );
    res.status(201).json(quote);
  }

  async getQuotes(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    const quotes = await marketService.listOperationQuotes(operationId);
    res.status(200).json(quotes);
  }

  async selectQuote(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    
    const parsed = SelectQuoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de selección inválidos.",
        parsed.error.format(),
      );
    }

    const selectedQuote = await marketService.selectMarketWinner(
      operationId,
      parsed.data,
      req.get("x-actor-id") ?? undefined,
    );
    res.status(200).json(selectedQuote);
  }
}

export const marketController = new MarketController();
