export const callDirections = ["INBOUND", "OUTBOUND"] as const;
export type CallDirection = (typeof callDirections)[number];

export const callPurposes = [
  "OPERATIONS",
  "QUOTE",
  "COMMIT",
  "EXECUTION",
  "INCIDENT",
  "DELIVERY",
  "RENEGOTIATION",
  "ESCALATION",
] as const;
export type CallPurpose = (typeof callPurposes)[number];

export const enqueueCallPurposes = [
  "QUOTE",
  "COMMIT",
  "RENEGOTIATION",
  "FOLLOW_UP",
  "ESCALATION",
] as const;
export type EnqueueCallPurpose = (typeof enqueueCallPurposes)[number];

export const callStatuses = [
  "QUEUED",
  "RINGING",
  "IN_PROGRESS",
  "COMPLETED",
  "BUSY",
  "NO_ANSWER",
  "FAILED",
] as const;
export type CallStatus = (typeof callStatuses)[number];

export const callBriefOutcomes = [
  "QUOTE_OBTAINED",
  "REFUSED",
  "NO_AGREEMENT",
  "COMMITTED",
  "INCIDENT_REPORTED",
  "ESCALATED",
  "COMPLETED",
] as const;
export type CallBriefOutcome = (typeof callBriefOutcomes)[number];

export interface CallBriefInput {
  summary: string;
  outcome: CallBriefOutcome;
  mentions: string[];
  objections?: string[];
  actions: string[];
  nextSteps?: string[];
}

export interface CallBrief extends CallBriefInput {
  callId: string;
  generatedAt: string;
}

export interface Call {
  id: string;
  operationId: string;
  carrierId: string | null;
  negotiationId: string | null;
  twilioCallSid: string | null;
  realtimeSessionId: string | null;
  direction: CallDirection;
  purpose: CallPurpose;
  status: CallStatus;
  fromNumber: string | null;
  toNumber: string | null;
  transcript: string | null;
  brief: CallBrief | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface EnqueueOutboundCallInput {
  operationId: string;
  carrierId: string;
  negotiationId?: string | null;
  purpose: EnqueueCallPurpose;
}

export interface CreateInboundCallInput {
  operationId: string;
  carrierId?: string | null;
  negotiationId?: string | null;
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  purpose: CallPurpose;
  status?: CallStatus;
}

export interface OutboundCallContext {
  toNumber: string | null;
}

export interface OutboundCallContextResolver {
  resolve(input: EnqueueOutboundCallInput): Promise<OutboundCallContext>;
}

export interface StartOutboundCallInput {
  callId: string;
  operationId: string;
  carrierId: string;
  negotiationId: string | null;
  purpose: CallPurpose;
  toNumber: string | null;
}

export interface TelephonyGateway {
  startOutboundCall(
    input: StartOutboundCallInput,
  ): Promise<{ providerCallId: string }>;
}

export interface CallScheduler {
  enqueueQuoteCalls(input: {
    operationId: string;
    campaignId: string;
    negotiations: Array<{
      negotiationId: string;
      carrierId: string;
      phone: string;
    }>;
  }): Promise<void>;
}

export function toCallResponse(call: Call) {
  return {
    id: call.id,
    operationId: call.operationId,
    carrierId: call.carrierId,
    negotiationId: call.negotiationId,
    twilioCallSid: call.twilioCallSid,
    direction: call.direction,
    purpose: call.purpose,
    status: call.status,
    transcript: call.transcript,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    createdAt: call.createdAt,
  };
}
