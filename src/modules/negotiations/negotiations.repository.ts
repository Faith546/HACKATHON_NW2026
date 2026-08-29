import { eq } from "drizzle-orm";
import { db } from "../../db";
import { negotiations } from "../../db/schema";

export class NegotiationsRepository {
  async getNegotiationById(negotiationId: string) {
    const [negotiation] = await db
      .select()
      .from(negotiations)
      .where(eq(negotiations.id, negotiationId));
    return negotiation ?? null;
  }
}

export const negotiationsRepository = new NegotiationsRepository();
