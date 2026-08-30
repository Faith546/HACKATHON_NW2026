import { eq } from "drizzle-orm";
import { db } from "../../db";
import { negotiations } from "../../db/schema";

export class NegotiationsRepository {
  getNegotiationById(negotiationId: string) {
    return db
      .select()
      .from(negotiations)
      .where(eq(negotiations.id, negotiationId))
      .get() ?? null;
  }
}

export const negotiationsRepository = new NegotiationsRepository();
