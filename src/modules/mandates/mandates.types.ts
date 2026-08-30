import { z } from "zod";
import type { mandates } from "../../db/schema";
import {
  CreateMandateInputSchema,
} from "../operations/operations.types";

export const CreateMandateVersionSchema = CreateMandateInputSchema;

export type CreateMandateVersionInput = z.infer<typeof CreateMandateVersionSchema>;

export type MandateRow = typeof mandates.$inferSelect;

export interface MandateResponse {
  id: string;
  operationId: string;
  version: number;
  status: "ACTIVE" | "SUPERSEDED";
  maxTotalPrice: number;
  currency: string;
  pickupDate: string;
  notes?: string;
  createdAt: string;
}

export function toMandateResponse(mandate: MandateRow): MandateResponse {
  return {
    id: mandate.id,
    operationId: mandate.operationId,
    version: mandate.version,
    status: mandate.status as MandateResponse["status"],
    maxTotalPrice: mandate.maxTotalPriceCents / 100,
    currency: mandate.currency,
    pickupDate: mandate.pickupDate,
    ...(mandate.notes === null ? {} : { notes: mandate.notes }),
    createdAt: mandate.createdAt,
  };
}
