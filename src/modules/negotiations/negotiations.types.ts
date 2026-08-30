import type { negotiations } from "../../db/schema";
import { EvaluateQuoteSchema } from "../market/market.types";

export function toNegotiationResponse(
  negotiation: typeof negotiations.$inferSelect,
) {
  let latestOffer: ReturnType<typeof EvaluateQuoteSchema.parse> | null = null;
  if (negotiation.latestOfferJson) {
    const parsed = EvaluateQuoteSchema.safeParse(
      JSON.parse(negotiation.latestOfferJson) as unknown,
    );
    latestOffer = parsed.success ? parsed.data : null;
  }
  return {
    id: negotiation.id,
    operationId: negotiation.operationId,
    campaignId: negotiation.campaignId,
    carrierId: negotiation.carrierId,
    status: negotiation.status,
    latestOffer,
    createdAt: negotiation.createdAt,
  };
}
