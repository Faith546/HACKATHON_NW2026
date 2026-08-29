import { db } from "../../db";
import { negotiations } from "../../db/schema";

export class NegotiationsRepository {
  async getNegotiationById(negotiationId: string) {
    const [negotiation] = await db.select().from(negotiations).where((cols, { eq }) => eq(cols.id, negotiationId));
    return negotiation ?? null;
  }
}

export const negotiationsRepository = new NegotiationsRepository();
