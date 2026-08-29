import { z } from "zod";

const minorAmountSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .describe("Money in minor units. Example: 8,500.00 MXN is 850000.");

const quotePricingSchema = z.discriminatedUnion("pricingMode", [
  z.object({
    pricingMode: z.literal("BASE_PLUS_FEES"),
    baseAmountMinor: minorAmountSchema
      .nullable()
      .describe("Base price in minor units, or null if it was not provided."),
    fees: z.array(
      z.object({
        label: z.string().trim().min(1),
        amountMinor: minorAmountSchema,
      }),
    ),
  }),
  z.object({
    pricingMode: z.literal("ALL_IN_TOTAL"),
    quotedTotalMinor: minorAmountSchema.describe(
      "The carrier's explicit ALL-IN total when no base/fee breakdown was given.",
    ),
  }),
]);

export const quoteInputSchema = z.object({
  pricing: quotePricingSchema,
  currency: z.string().trim().min(1).describe("ISO 4217 currency code."),
  pickupDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("Local pickup date as YYYY-MM-DD, or null when unknown."),
  pickupWindowStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .describe("Local pickup window start as HH:mm, or null when unknown."),
  pickupWindowEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .describe("Local pickup window end as HH:mm, or null when unknown."),
  conditions: z.array(z.string().trim().min(1)),
  allInConfirmed: z
    .boolean()
    .describe("True only when the carrier explicitly confirmed the total is ALL-IN."),
});

export type QuoteInput = z.infer<typeof quoteInputSchema>;
export type QuotePricing = z.infer<typeof quotePricingSchema>;
export type BasePlusFeesPricing = Extract<
  QuotePricing,
  { pricingMode: "BASE_PLUS_FEES" }
>;
export type AllInTotalPricing = Extract<
  QuotePricing,
  { pricingMode: "ALL_IN_TOTAL" }
>;

export const quoteValidationReasons = [
  "TOTAL_EXCEEDS_MANDATE",
  "PICKUP_OUTSIDE_WINDOW",
  "WRONG_CURRENCY",
  "MISSING_PRICE",
  "MISSING_PICKUP",
  "ALL_IN_NOT_CONFIRMED",
] as const;

export type QuoteValidationReason = (typeof quoteValidationReasons)[number];

export type QuoteValidationResult = {
  eligible: boolean;
  totalAmountMinor: number | null;
  reasons: QuoteValidationReason[];
};

export type Quote = QuoteInput &
  QuoteValidationResult & {
    quoteId: string;
    operationId: string;
    callId: string;
    mandateVersion: number;
    carrierId?: string;
    createdAt: string;
    supersedesQuoteId?: string;
  };

export type RecordQuoteResult = QuoteValidationResult & {
  ok: true;
  quoteId: string;
};
