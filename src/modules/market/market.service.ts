import { marketRepository } from "./market.repository";
import type {
  EvaluateQuoteInput,
  GroundedSaveQuoteInput,
  SelectQuoteInput,
} from "./market.types";
import { toQuoteResponse } from "./market.types";

export class MarketService {
  async evaluateOffer(
    negotiationId: string,
    input: EvaluateQuoteInput,
    actorId?: string,
  ) {
    return marketRepository.evaluateQuote(negotiationId, input, actorId);
  }

  async recordQuote(
    negotiationId: string,
    input: GroundedSaveQuoteInput,
    actorId?: string,
  ) {
    return toQuoteResponse(
      marketRepository.saveQuote(negotiationId, input, actorId),
      input.dispatcherName,
    );
  }

  async listOperationQuotes(operationId: string) {
    return marketRepository
      .getQuotesByOperationId(operationId)
      .map(({ quote, dispatcherName }) =>
        toQuoteResponse(quote, dispatcherName),
      );
  }

  async selectMarketWinner(
    operationId: string,
    input: SelectQuoteInput,
    actorId?: string,
  ) {
    return marketRepository.selectQuote(operationId, input, actorId);
  }
}

export const marketService = new MarketService();
