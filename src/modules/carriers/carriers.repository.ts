import { db } from "../../db";
import { carriers } from "../../db/schema";
import type { CreateCarrierInput } from "./carriers.types";
import { eq } from "drizzle-orm";

export class CarrierRepository {
  findAll() {
    return db.select().from(carriers).orderBy(carriers.name, carriers.id).all();
  }

  create(data: CreateCarrierInput) {
    return db
      .insert(carriers)
      .values({
        name: data.name,
        dispatcherName: data.dispatcherName,
        phone: data.phone,
        email: data.email ?? null,
        score: data.score,
      })
      .returning()
      .get();
  }

  deactivate(carrierId: string) {
    return (
      db
        .update(carriers)
        .set({ active: false })
        .where(eq(carriers.id, carrierId))
        .returning()
        .get() ?? null
    );
  }
}

export const carrierRepository = new CarrierRepository();
