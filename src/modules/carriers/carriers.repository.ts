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
}

export const carrierRepository = new CarrierRepository();
