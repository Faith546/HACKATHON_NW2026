import type { VoiceToolName } from "../voice/voice-core.port";

export const realtimeActorTypes = [
  "INTERNAL_OPERATOR",
  "CARRIER",
  "DISPATCHER",
  "DRIVER",
] as const;
export type RealtimeActorType = (typeof realtimeActorTypes)[number];

export const realtimeModes = [
  "OPERATIONS",
  "QUOTE",
  "COMMIT",
  "EXECUTION",
  "INCIDENT",
  "DELIVERY",
] as const;
export type RealtimeMode = (typeof realtimeModes)[number];
export type RealtimeAgentType = "OPERATIONS_AGENT" | "LOGISTICS_AGENT";
export type RealtimeSessionStatus = "ACTIVE" | "CLOSED";

export interface CreateRealtimeSessionInput {
  callId: string;
  actorType: RealtimeActorType;
  carrierId?: string | null;
  operationId?: string | null;
  negotiationId?: string | null;
  mode: RealtimeMode;
}

export interface TranscriptSegment {
  id: string;
  speaker: "AGENT" | "HUMAN";
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
  interrupted: boolean;
}

export interface RealtimeSession {
  id: string;
  callId: string;
  operationId: string | null;
  carrierId: string | null;
  negotiationId: string | null;
  actorType: RealtimeActorType;
  agent: RealtimeAgentType;
  mode: RealtimeMode;
  mandateId: string | null;
  allowedTools: VoiceToolName[];
  status: RealtimeSessionStatus;
  transcriptSegments: TranscriptSegment[];
  createdAt: string;
  closedAt: string | null;
}

export interface RealtimeSessionResponse {
  id: string;
  callId: string;
  operationId: string | null;
  actorType: RealtimeActorType;
  agent: RealtimeAgentType;
  mode: RealtimeMode;
  mandateId: string | null;
  allowedTools: VoiceToolName[];
  status: RealtimeSessionStatus;
}

export function toRealtimeSessionResponse(
  session: RealtimeSession,
): RealtimeSessionResponse {
  return {
    id: session.id,
    callId: session.callId,
    operationId: session.operationId,
    actorType: session.actorType,
    agent: session.agent,
    mode: session.mode,
    mandateId: session.mandateId,
    allowedTools: [...session.allowedTools],
    status: session.status,
  };
}
