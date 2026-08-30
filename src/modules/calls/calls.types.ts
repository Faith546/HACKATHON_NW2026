export const callDirections = ["INBOUND", "OUTBOUND"] as const;
export type CallDirection = (typeof callDirections)[number];

export const callActorTypes = [
  "INTERNAL_OPERATOR",
  "CARRIER",
  "DISPATCHER",
  "DRIVER",
] as const;
export type CallActorType = (typeof callActorTypes)[number];

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
  operationId: string | null;
  carrierId: string | null;
  negotiationId: string | null;
  actorType: CallActorType;
  twilioCallSid: string | null;
  twilioStreamSid: string | null;
  recordingSid: string | null;
  recordingStatus: string | null;
  recordingUrl: string | null;
  recordingDurationSeconds: number | null;
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
  operationId: string | null;
  carrierId?: string | null;
  negotiationId?: string | null;
  actorType: CallActorType;
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
    maxParallelCalls: number;
    negotiations: Array<{
      negotiationId: string;
      carrierId: string;
      phone: string;
    }>;
  }): Promise<void>;
}

export interface CallLifecycleObserver {
  onStatusChanged(input: {
    call: Call;
    previousStatus: CallStatus;
    changed: boolean;
  }): Promise<void> | void;
}

export function toCallResponse(call: Call) {
  return {
    id: call.id,
    operationId: call.operationId,
    carrierId: call.carrierId,
    negotiationId: call.negotiationId,
    actorType: call.actorType,
    twilioCallSid: call.twilioCallSid,
    twilioStreamSid: call.twilioStreamSid,
    recording: call.recordingStatus === null ? null : {
      sid: call.recordingSid,
      status: call.recordingStatus,
      url: call.recordingUrl,
      durationSeconds: call.recordingDurationSeconds,
      correlationStatus: "UNRESOLVED",
      reason: "RECORDING_START_OFFSET_UNKNOWN",
    },
    direction: call.direction,
    purpose: call.purpose,
    status: call.status,
    transcript: call.transcript,
    brief: call.brief,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    createdAt: call.createdAt,
  };
}
