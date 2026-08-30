import { z } from "zod";

const requiredText = z.string().trim().min(1);

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, "La fecha debe ser una fecha ISO 8601 válida.");

export const ReportIncidentSchema = z.object({
  callId: requiredText,
  type: requiredText,
  description: requiredText,
  reportedBy: requiredText.optional(),
});

export type ReportIncidentInput = z.infer<typeof ReportIncidentSchema>;

export const EvaluateChangeSchema = z.object({
  proposedPickupDate: isoDate.optional(),
  proposedTotalPrice: z
    .number()
    .finite()
    .positive()
    .max(Number.MAX_SAFE_INTEGER / 100)
    .optional(),
  notes: requiredText.optional(),
});

export type EvaluateChangeInput = z.infer<typeof EvaluateChangeSchema>;

export const evaluationCodes = [
  "ALLOWED",
  "PRICE_EXCEEDS_MANDATE",
  "DATE_OUTSIDE_MANDATE",
] as const;

export type EvaluationCode = (typeof evaluationCodes)[number];

export interface EvaluationResult {
  allowed: boolean;
  code: EvaluationCode;
  mandateId: string;
  reasons: string[];
}
