import { z } from "zod";

export const EvaluateQuoteSchema = z.object({
  totalPrice: z.number().positive(),
  currency: z.string().default("MXN"),
  pickupDate: z.string().datetime({ offset: true }),
});

export type EvaluateQuoteInput = z.infer<typeof EvaluateQuoteSchema>;

export const SaveQuoteSchema = EvaluateQuoteSchema.extend({
  callId: z.string().optional(),
  notes: z.string().optional(),
});

export type SaveQuoteInput = z.infer<typeof SaveQuoteSchema>;

export const SelectQuoteSchema = z.object({
  quoteId: z.string().min(1),
  operatorId: z.string().min(1),
});

export type SelectQuoteInput = z.infer<typeof SelectQuoteSchema>;
