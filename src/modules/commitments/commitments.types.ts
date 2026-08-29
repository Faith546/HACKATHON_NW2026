import { z } from "zod";

export const CreateCommitmentSchema = z.object({
  quoteId: z.string().min(1),
  exactTerms: z.string().optional(),
});

export type CreateCommitmentInput = z.infer<typeof CreateCommitmentSchema>;

export const ConfirmCommitmentSchema = z.object({
  callId: z.string().min(1),
  evidenceStartMs: z.number().int().nonnegative(),
  evidenceEndMs: z.number().int().positive(),
  evidenceTranscriptExcerpt: z.string().min(1),
  confirmedBy: z.string().min(1),
});

export type ConfirmCommitmentInput = z.infer<typeof ConfirmCommitmentSchema>;
