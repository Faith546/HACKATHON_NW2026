import { ApiError } from "../../shared/http/api-error";
import { campaignsService } from "../campaigns/campaigns.service";
import { negotiationsRepository } from "./negotiations.repository";
import { toNegotiationResponse } from "./negotiations.types";

export class NegotiationsService {
  async getNegotiation(negotiationId: string) {
    const negotiation = negotiationsRepository.getNegotiationById(negotiationId);
    if (!negotiation) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Negociación no encontrada.",
        { negotiationId },
      );
    }
    return toNegotiationResponse(negotiation);
  }

  async reportNoAnswer(negotiationId: string) {
    return campaignsService.reportNoAnswer(negotiationId);
  }
}

export const negotiationsService = new NegotiationsService();
