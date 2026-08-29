import { z } from "zod";

export const CreateCampaignSchema = z.object({
  requestedCarriers: z.number().int().positive().default(3),
  maxParallelCalls: z.number().int().min(1).max(3).default(3),
  strategy: z.enum(["LOWEST_VALID_TOTAL", "BALANCED_SCORE"]).default("LOWEST_VALID_TOTAL"),
});

export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;
