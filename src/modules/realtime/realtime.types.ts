import type { VoiceToolName } from "../voice/voice-core.port";

export const realtimeActorTypes = [
  "CARRIER",
  "DISPATCHER",
  "DRIVER",
] as const;
export type RealtimeActorType = (typeof realtimeActorTypes)[number];

export const realtimeModes = [
  "QUOTE",
  "COMMIT",
  "EXECUTION",
  "INCIDENT",
  "DELIVERY",
] as const;
export type RealtimeMode = (typeof realtimeModes)[number];
export type RealtimeAgentType = "LOGISTICS_AGENT";
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
  source: "CALLER_AUDIO" | "AGENT_AUDIO" | "PROGRAMMATIC_TEXT";
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
  interrupted: boolean;
}

export interface RealtimeSession {
  id: string;
  callId: string;
  operationId: string;
  carrierId: string | null;
  negotiationId: string | null;
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
    agent: session.agent,
    mode: session.mode,
    mandateId: session.mandateId,
    allowedTools: [...session.allowedTools],
    status: session.status,
  };
}
