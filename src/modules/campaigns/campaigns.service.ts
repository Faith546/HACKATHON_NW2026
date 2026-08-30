import type { CallScheduler } from "../calls/calls.types";
import { ApiError } from "../../shared/http/api-error";
import {
  CampaignsRepository,
  campaignsRepository,
} from "./campaigns.repository";
import type { CreateCampaignInput } from "./campaigns.types";
import { toCampaignResponse } from "./campaigns.types";

export class CampaignsService {
  constructor(
    private readonly repository: CampaignsRepository = campaignsRepository,
    private callScheduler: CallScheduler | null = null,
  ) {}

  setCallScheduler(callScheduler: CallScheduler | null): void {
    this.callScheduler = callScheduler;
  }

  async startCampaign(
    operationId: string,
    input: CreateCampaignInput,
    actorId?: string,
  ) {
    const created = this.repository.createCampaign(operationId, input, actorId);
    if (this.callScheduler) {
      try {
        await this.callScheduler.enqueueQuoteCalls({
          operationId,
          campaignId: created.campaign.id,
          maxParallelCalls: input.maxParallelCalls,
          negotiations: created.targets,
        });
        this.repository.markCallsEnqueued(created.campaign.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.repository.markCampaignFailed(created.campaign.id, reason);
        throw new ApiError(
          503,
          "CAMPAIGN_CALL_ENQUEUE_FAILED",
          "La campaña se creó, pero sus llamadas no pudieron encolarse.",
          { campaignId: created.campaign.id },
        );
      }
    }
    return this.getCampaign(operationId, created.campaign.id);
  }

  async getCampaign(operationId: string, campaignId: string) {
    const result = this.repository.getCampaignById(operationId, campaignId);
    if (!result) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Campaña no encontrada para la operación indicada.",
        { operationId, campaignId },
      );
    }
    return toCampaignResponse(result.campaign, result.progress);
  }

  async markNegotiationCalling(negotiationId: string) {
    const negotiation = this.repository.transitionNegotiation(
      negotiationId,
      "CALLING",
    );
    return this.refreshCampaign(negotiation.campaignId);
  }

  async markNegotiationInProgress(negotiationId: string) {
    const negotiation = this.repository.transitionNegotiation(
      negotiationId,
      "NEGOTIATING",
    );
    return this.refreshCampaign(negotiation.campaignId);
  }

  async reportNoAnswer(negotiationId: string) {
    const negotiation = this.repository.transitionNegotiation(
      negotiationId,
      "NO_ANSWER",
    );
    return this.refreshCampaign(negotiation.campaignId);
  }

  async reportRefused(negotiationId: string, actorId?: string) {
    const negotiation = this.repository.transitionNegotiation(
      negotiationId,
      "REFUSED",
      actorId,
    );
    return this.refreshCampaign(negotiation.campaignId);
  }

  async refreshCampaign(campaignId: string) {
    const result = this.repository.refreshCampaign(campaignId);
    return toCampaignResponse(result.campaign, result.progress);
  }
}

export const campaignsService = new CampaignsService();

export function configureCampaignCallScheduler(
  scheduler: CallScheduler | null,
): void {
  campaignsService.setCallScheduler(scheduler);
}
