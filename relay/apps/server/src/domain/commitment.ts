export const commitmentStatuses = [
  "RECAP_PENDING",
  "ACTIVE",
  "RECAP_FAILED",
  "SUPERSEDED",
  "CANCELLED",
] as const;

export type CommitmentStatus = (typeof commitmentStatuses)[number];

// No quote-to-commitment transition exists in Checkpoint 3. ACTIVE will only be
// reachable through a future recap-verification workflow.
export type Commitment = {
  commitmentId: string;
  operationId: string;
  callId: string;
  status: CommitmentStatus;
};
