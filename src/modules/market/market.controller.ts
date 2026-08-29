import type { Request, Response } from "express";
import { marketRepository } from "./market.repository";
import { EvaluateQuoteSchema, SaveQuoteSchema, SelectQuoteSchema } from "./market.types";
import { ApiError } from "../../shared/http/api-error";

export class MarketController {
  async evaluate(req: Request, res: Response) {
    const negotiationId = req.params.negotiationId as string;
    
    const parsed = EvaluateQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de evaluación inválidos", parsed.error.format());
    }

    const evaluation = await marketRepository.evaluateQuote(negotiationId, parsed.data);
    res.status(200).json(evaluation);
  }

  async save(req: Request, res: Response) {
    const negotiationId = req.params.negotiationId as string;
    
    const parsed = SaveQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de cotización inválidos", parsed.error.format());
    }

    // Usaremos un actor genérico de IA por defecto a menos que se mande en los headers
    const actorId = req.headers["x-actor-id"] as string | undefined;

    const quote = await marketRepository.saveQuote(negotiationId, parsed.data, actorId);
    res.status(201).json(quote);
  }

  async getQuotes(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    const quotes = await marketRepository.getQuotesByOperationId(operationId);
    res.status(200).json(quotes);
  }

  async selectQuote(req: Request, res: Response) {
    const operationId = req.params.operationId as string;
    
    const parsed = SelectQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Datos de selección inválidos", parsed.error.format());
    }

    const selectedQuote = await marketRepository.selectQuote(operationId, parsed.data);
    res.status(200).json(selectedQuote);
  }
}

export const marketController = new MarketController();
