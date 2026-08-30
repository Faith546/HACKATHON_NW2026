import { z } from "zod";
import type { quotes } from "../../db/schema";
import {
  currencySchema,
  isoDateSchema,
  moneySchema,
} from "../operations/operations.types";

export const EvaluateQuoteSchema = z.object({
  totalPrice: moneySchema,
  currency: currencySchema,
  pickupDate: isoDateSchema,
  notes: z.string().trim().min(1).optional(),
});

export type EvaluateQuoteInput = z.infer<typeof EvaluateQuoteSchema>;

export const SaveQuoteSchema = EvaluateQuoteSchema.extend({
  validUntil: z.string().datetime({ offset: true }),
  dispatcherName: z.string().trim().min(1).optional(),
  callId: z.string().trim().min(1).optional(),
});

export type SaveQuoteInput = z.infer<typeof SaveQuoteSchema>;

export const marketStrategies = [
  "LOWEST_VALID_TOTAL",
  "BALANCED_SCORE",
] as const;

export type MarketStrategy = (typeof marketStrategies)[number];

export const SelectQuoteSchema = z
  .object({
    strategy: z.enum(marketStrategies).default("LOWEST_VALID_TOTAL"),
  })
  .default({ strategy: "LOWEST_VALID_TOTAL" });

export type SelectQuoteInput = z.infer<typeof SelectQuoteSchema>;

export type EvaluationCode =
  | "ALLOWED"
  | "CURRENCY_MISMATCH"
  | "PRICE_EXCEEDS_MANDATE"
  | "DATE_OUTSIDE_MANDATE";

export interface EvaluationResult {
  allowed: boolean;
  code: EvaluationCode;
  mandateId: string;
  reasons: string[];
}

export function toQuoteResponse(
  quote: typeof quotes.$inferSelect,
  fallbackDispatcherName?: string | null,
) {
  const dispatcherName = quote.dispatcherName ?? fallbackDispatcherName;
  return {
    id: quote.id,
    negotiationId: quote.negotiationId,
    carrierId: quote.carrierId,
    totalPrice: quote.totalPriceCents / 100,
    currency: quote.currency,
    pickupDate: quote.pickupDate,
    ...(quote.notes === null ? {} : { notes: quote.notes }),
    validUntil: quote.validUntil,
    ...(dispatcherName ? { dispatcherName } : {}),
    ...(quote.callId === null ? {} : { callId: quote.callId }),
    valid: quote.valid,
    invalidReason: quote.invalidReason,
    mandateId: quote.mandateId,
    createdAt: quote.createdAt,
  };
}
