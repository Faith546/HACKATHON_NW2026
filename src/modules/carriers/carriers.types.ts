import { z } from "zod";
import type { carriers } from "../../db/schema";

export const CreateCarrierSchema = z.object({
  name: z.string().trim().min(1),
  dispatcherName: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  score: z.number().int().min(0).max(100).default(80),
});

export type CreateCarrierInput = z.infer<typeof CreateCarrierSchema>;

export function toCarrierResponse(carrier: typeof carriers.$inferSelect) {
  return {
    id: carrier.id,
    name: carrier.name,
    dispatcherName: carrier.dispatcherName,
    phone: carrier.phone,
    ...(carrier.email === null ? {} : { email: carrier.email }),
    score: carrier.score,
    active: carrier.active,
  };
}
