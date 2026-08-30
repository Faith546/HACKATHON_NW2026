import { z } from "zod";
import type { campaigns } from "../../db/schema";

export const CreateCampaignSchema = z.object({
  carrierIds: z
    .array(z.string().trim().min(1))
    .min(3)
    .superRefine((carrierIds, context) => {
      if (new Set(carrierIds).size !== carrierIds.length) {
        context.addIssue({
          code: "custom",
          message: "carrierIds no puede contener duplicados.",
        });
      }
    }),
  maxParallelCalls: z.number().int().min(1).max(3).default(3),
});

export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

export interface CampaignProgress {
  completedNegotiations: number;
  quoteCount: number;
}

export function toCampaignResponse(
  campaign: typeof campaigns.$inferSelect,
  progress: CampaignProgress,
) {
  return {
    id: campaign.id,
    operationId: campaign.operationId,
    status: campaign.status,
    requestedCarriers: campaign.requestedCarriers,
    completedNegotiations: progress.completedNegotiations,
    quoteCount: progress.quoteCount,
    createdAt: campaign.createdAt,
  };
}
