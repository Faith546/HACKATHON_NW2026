import { z } from "zod";

const requiredText = z.string().trim().min(1);
export const e164Phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "El teléfono debe usar formato E.164.");

export const escalationReasons = [
  "OUTSIDE_MANDATE",
  "IDENTITY_UNCLEAR",
  "CONTRADICTION",
  "HUMAN_REQUESTED",
  "TOOL_FAILURE",
  "OTHER",
] as const;

export type EscalationReason = (typeof escalationReasons)[number];

export const RequestEscalationSchema = z.object({
  callId: requiredText,
  incidentId: requiredText.nullable().optional(),
  reason: z.enum(escalationReasons),
  contextSummary: requiredText,
  requestedHumanPhone: e164Phone.nullable().optional(),
});

export type RequestEscalationInput = z.infer<
  typeof RequestEscalationSchema
>;

export const JoinHumanSchema = z.object({
  humanPhone: e164Phone,
});

export type JoinHumanInput = z.infer<typeof JoinHumanSchema>;
