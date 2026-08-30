import { z } from "zod";
import type { commitments } from "../../db/schema";

const requiredText = z.string().trim().min(1);

export const AuthorizeCommitmentSchema = z
  .object({
    winningQuoteId: requiredText,
  })
  .strict();

export type AuthorizeCommitmentInput = z.infer<
  typeof AuthorizeCommitmentSchema
>;

export const VerbalAgreementSchema = z
  .object({
    callId: requiredText,
    confirmedBy: requiredText,
    exactTerms: requiredText,
  })
  .strict();

export type VerbalAgreementInput = z.infer<typeof VerbalAgreementSchema>;

export const AttachEvidenceSchema = z
  .object({
    callId: requiredText,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    transcriptExcerpt: requiredText,
  })
  .strict()
  .refine((input) => input.startMs < input.endMs, {
    message: "startMs debe ser menor que endMs.",
    path: ["endMs"],
  });

export type AttachEvidenceInput = z.infer<typeof AttachEvidenceSchema>;

export const SendSummarySchema = z
  .object({
    channel: z.literal("SMS"),
    recipient: requiredText,
    message: requiredText,
  })
  .strict();

export type SendSummaryInput = z.infer<typeof SendSummarySchema>;

export const commitmentStatuses = [
  "PROPOSED",
  "VERBALLY_AGREED",
  "MANDATE_VALIDATED",
  "SUMMARY_PENDING",
  "SUMMARY_SENT",
  "VALID",
  "IN_EXECUTION",
  "FULFILLED",
  "CANCELLED_BY_CARRIER",
  "CANCELLED",
] as const;

export type CommitmentStatus = (typeof commitmentStatuses)[number];
export type CommitmentRecord = typeof commitments.$inferSelect;

export interface CommitmentResponse {
  id: string;
  operationId: string;
  quoteId: string;
  carrierId: string;
  status: CommitmentStatus;
  mandateId: string;
  totalPrice: number;
  currency: string;
  pickupDate: string;
  verbalAgreementCallId: string | null;
  evidenceStartMs: number | null;
  evidenceEndMs: number | null;
  evidenceTranscriptExcerpt: string | null;
  summaryChannel: "SMS" | "EMAIL" | null;
  summaryProviderId: string | null;
  summarySentAt: string | null;
  createdAt: string;
}

export function toCommitmentResponse(
  commitment: CommitmentRecord,
): CommitmentResponse {
  return {
    id: commitment.id,
    operationId: commitment.operationId,
    quoteId: commitment.quoteId,
    carrierId: commitment.carrierId,
    status: commitment.status as CommitmentStatus,
    mandateId: commitment.mandateId,
    totalPrice: commitment.totalPriceCents / 100,
    currency: commitment.currency,
    pickupDate: commitment.pickupDate,
    verbalAgreementCallId: commitment.verbalAgreementCallId,
    evidenceStartMs: commitment.evidenceStartMs,
    evidenceEndMs: commitment.evidenceEndMs,
    evidenceTranscriptExcerpt: commitment.evidenceTranscriptExcerpt,
    summaryChannel: commitment.summaryChannel as "SMS" | "EMAIL" | null,
    summaryProviderId: commitment.summaryProviderId,
    summarySentAt: commitment.summarySentAt,
    createdAt: commitment.createdAt,
  };
}

// Compatibility names retained for the in-process Voice facade.
export const CreateCommitmentSchema = AuthorizeCommitmentSchema;
export type CreateCommitmentInput = AuthorizeCommitmentInput;
export const ConfirmCommitmentSchema = VerbalAgreementSchema;
export type ConfirmCommitmentInput = VerbalAgreementInput;
