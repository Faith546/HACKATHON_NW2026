import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { carriers } from "../../db/schema";
import type { CreateCarrierInput } from "./carriers.types";

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

  restoreInactive(data: CreateCarrierInput) {
    return (
      db
        .update(carriers)
        .set({
          name: data.name,
          dispatcherName: data.dispatcherName,
          email: data.email ?? null,
          score: data.score,
          active: true,
        })
        .where(
          and(eq(carriers.phone, data.phone), eq(carriers.active, false)),
        )
        .returning()
        .get() ?? null
    );
  }
}

export const carrierRepository = new CarrierRepository();
