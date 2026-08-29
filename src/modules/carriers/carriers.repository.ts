import { db } from "../../db";
import { carriers } from "../../db/schema";
import type { CreateCarrierInput } from "./carriers.types";

export class CarrierRepository {
  async findAll() {
    return db.select().from(carriers);
  }

  async create(data: CreateCarrierInput) {
    const [carrier] = await db.insert(carriers).values({
      name: data.name,
      dispatcherName: data.dispatcherName,
      phone: data.phone,
      email: data.email,
    }).returning();
    return carrier;
  }
}

export const carrierRepository = new CarrierRepository();
