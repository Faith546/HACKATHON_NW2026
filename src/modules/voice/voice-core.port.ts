import type {
  CallPurpose,
  EnqueueOutboundCallInput,
} from "../calls/calls.types";

export interface VoiceMandateSnapshot {
  id: string;
  operationId: string;
  version: number;
  maxTotalPriceCents: number;
  currency: string;
  pickupDate: string;
  notes: string | null;
}

export interface InboundCallResolution {
  operationId: string;
  carrierId: string | null;
  negotiationId: string | null;
  purpose: CallPurpose;
}

export const voiceToolNames = [
  "createOperation",
  "createMandate",
  "getOperationStatus",
  "listCarriers",
  "startCampaign",
  "getQuotes",
  "getCommitments",
  "cancelOperation",
  "getActiveMandate",
  "evaluateOffer",
  "recordQuote",
  "reportNoAnswer",
  "getAuthorizedCommitment",
  "recordVerbalAgreement",
  "attachCommitmentEvidence",
  "enqueueCommitmentSummary",
  "getOperation",
  "reportIncident",
  "evaluateIncidentChange",
  "requestEscalation",
  "confirmPickup",
  "confirmDelivery",
  "saveCallBrief",
] as const;
export type VoiceToolName = (typeof voiceToolNames)[number];

export interface VoiceToolContext {
  callId: string;
  operationId: string;
  carrierId: string | null;
  negotiationId: string | null;
  mandateId: string | null;
  transcriptEvidence?: {
    startMs: number;
    endMs: number;
    transcriptExcerpt: string;
  };
  quoteGrounding?: {
    callerItemId: string;
    transcript: string;
    startMs: number;
    endMs: number;
    amountCents: number;
    currency: string;
    provenance: "CALLER_AUDIO_FINAL_TRANSCRIPT";
  };
}

export interface VoiceCorePort {
  resolveOutboundCallContext(
    input: EnqueueOutboundCallInput,
  ): Promise<{ toNumber: string }>;
  resolveInboundCallContext(input: {
    fromNumber: string;
    toNumber: string;
  }): Promise<InboundCallResolution>;
  getActiveMandate(
    operationId: string,
  ): Promise<VoiceMandateSnapshot | null>;
  executeVoiceTool(input: {
    name: VoiceToolName;
    context: VoiceToolContext;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
}
