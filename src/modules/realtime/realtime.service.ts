import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../../shared/audit/audit-writer";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";
import type {
  VoiceCorePort,
  VoiceToolName,
} from "../voice/voice-core.port";
import type { RealtimeSessionRepository } from "./realtime.repository";
import {
  type CreateRealtimeSessionInput,
  type RealtimeAgentType,
  type RealtimeMode,
  type RealtimeSession,
  type TranscriptSegment,
} from "./realtime.types";

const toolsByMode: Record<RealtimeMode, VoiceToolName[]> = {
  CREATE_OPERATION: ["createOperation", "createMandate"],
  QUOTE: [
    "getActiveMandate",
    "evaluateOffer",
    "recordQuote",
    "reportNoAnswer",
    "saveCallBrief",
  ],
  COMMIT: [
    "getActiveMandate",
    "getAuthorizedCommitment",
    "recordVerbalAgreement",
    "attachCommitmentEvidence",
    "enqueueCommitmentSummary",
    "saveCallBrief",
  ],
  INCIDENT: [
    "getOperation",
    "getActiveMandate",
    "reportIncident",
    "evaluateIncidentChange",
    "requestEscalation",
    "saveCallBrief",
  ],
  EXECUTION: [
    "getOperation",
    "getActiveMandate",
    "confirmPickup",
    "reportIncident",
    "requestEscalation",
    "saveCallBrief",
  ],
  DELIVERY: [
    "getOperation",
    "confirmDelivery",
    "reportIncident",
    "requestEscalation",
    "saveCallBrief",
  ],
};

export interface RealtimeServiceDependencies {
  repository: RealtimeSessionRepository;
  callsService: CallsService;
  voiceCore: VoiceCorePort;
  auditWriter?: AuditWriter;
  now?: () => Date;
  createId?: () => string;
}

export class RealtimeService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly dependencies: RealtimeServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? (() => `rts_${randomUUID()}`);
  }

  async create(input: CreateRealtimeSessionInput): Promise<RealtimeSession> {
    const call = await this.dependencies.callsService.getById(input.callId);
    this.assertMatchingContext("operationId", input.operationId, call.operationId);
    this.assertMatchingContext("carrierId", input.carrierId, call.carrierId);
    this.assertMatchingContext(
      "negotiationId",
      input.negotiationId,
      call.negotiationId,
    );

    const existing = await this.dependencies.repository.findActiveByCallId(
      call.id,
    );
    if (existing) return existing;

    const agent: RealtimeAgentType =
      input.actorType === "INTERNAL_OPERATOR"
        ? "OPERATIONS_AGENT"
        : "LOGISTICS_AGENT";
    if (input.mode === "CREATE_OPERATION" && agent !== "OPERATIONS_AGENT") {
      throw new ApiError(
        403,
        "REALTIME_MODE_FORBIDDEN",
        "Sólo Operations Agent puede usar CREATE_OPERATION.",
      );
    }
    if (input.mode !== "CREATE_OPERATION" && agent === "OPERATIONS_AGENT") {
      throw new ApiError(
        403,
        "REALTIME_MODE_FORBIDDEN",
        "Operations Agent no puede asumir una sesión Logistics.",
      );
    }

    const mandate =
      input.mode === "CREATE_OPERATION"
        ? null
        : await this.dependencies.voiceCore.getActiveMandate(call.operationId);
    const session: RealtimeSession = {
      id: this.createId(),
      callId: call.id,
      operationId: call.operationId,
      carrierId: call.carrierId,
      negotiationId: call.negotiationId,
      agent,
      mode: input.mode,
      mandateId: mandate?.id ?? null,
      allowedTools: [...toolsByMode[input.mode]],
      status: "ACTIVE",
      transcriptSegments: [],
      createdAt: this.now().toISOString(),
      closedAt: null,
    };
    await this.dependencies.repository.insert(session);
    await this.dependencies.callsService.linkRealtimeSession(call.id, session.id);
    await this.dependencies.auditWriter?.record({
      operationId: call.operationId,
      eventType: "REALTIME_SESSION_CREATED",
      actorType: agent,
      callId: call.id,
      entityType: "REALTIME_SESSION",
      entityId: session.id,
      mandateId: session.mandateId,
      payload: { mode: session.mode, allowedTools: session.allowedTools },
    });
    return session;
  }

  async getActiveByCallId(callId: string): Promise<RealtimeSession | null> {
    return this.dependencies.repository.findActiveByCallId(callId);
  }

  async appendTranscriptSegment(
    sessionId: string,
    segment: TranscriptSegment,
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    if (session.status !== "ACTIVE") return;
    const index = session.transcriptSegments.findIndex(
      (existing) => existing.id === segment.id,
    );
    if (index >= 0) {
      session.transcriptSegments[index] = {
        ...session.transcriptSegments[index],
        ...structuredClone(segment),
        interrupted:
          session.transcriptSegments[index].interrupted || segment.interrupted,
      };
    } else {
      session.transcriptSegments.push(structuredClone(segment));
    }
    await this.dependencies.repository.save(session);
  }

  async executeTool(
    sessionId: string,
    name: VoiceToolName,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    const session = await this.requireSession(sessionId);
    if (session.status !== "ACTIVE") {
      throw new ApiError(409, "REALTIME_SESSION_CLOSED", "La sesión está cerrada.");
    }
    if (!session.allowedTools.includes(name)) {
      throw new ApiError(
        403,
        "REALTIME_TOOL_FORBIDDEN",
        "La tool no está autorizada para esta sesión.",
        { name, mode: session.mode },
      );
    }
    return this.dependencies.voiceCore.executeVoiceTool({
      name,
      context: {
        callId: session.callId,
        operationId: session.operationId,
        carrierId: session.carrierId,
        negotiationId: session.negotiationId,
        mandateId: session.mandateId,
      },
      arguments: argumentsValue,
    });
  }

  async close(sessionId: string): Promise<void> {
    const session = await this.dependencies.repository.findById(sessionId);
    if (!session || session.status === "CLOSED") return;
    session.status = "CLOSED";
    session.closedAt = this.now().toISOString();
    await this.dependencies.repository.save(session);

    const transcript = consolidateTranscript(session.transcriptSegments);
    if (transcript) {
      await this.dependencies.callsService.saveTranscript(
        session.callId,
        transcript,
      );
    }
    await this.dependencies.callsService.linkRealtimeSession(session.callId, null);
    await this.dependencies.auditWriter?.record({
      operationId: session.operationId,
      eventType: "REALTIME_SESSION_CLOSED",
      actorType: session.agent,
      callId: session.callId,
      entityType: "REALTIME_SESSION",
      entityId: session.id,
      mandateId: session.mandateId,
      payload: { transcriptSegments: session.transcriptSegments.length },
    });
    await this.dependencies.repository.delete(session.id);
  }

  private async requireSession(sessionId: string): Promise<RealtimeSession> {
    const session = await this.dependencies.repository.findById(sessionId);
    if (!session) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "La sesión Realtime no existe.",
        { sessionId },
      );
    }
    return session;
  }

  private assertMatchingContext(
    field: string,
    requested: string | null | undefined,
    actual: string | null,
  ): void {
    if (requested !== undefined && requested !== null && requested !== actual) {
      throw new ApiError(
        422,
        "REALTIME_CONTEXT_MISMATCH",
        `${field} no coincide con la llamada.`,
        { field, requested, actual },
      );
    }
  }
}

function consolidateTranscript(segments: TranscriptSegment[]): string {
  return [...segments]
    .sort((left, right) => left.startMs - right.startMs)
    .filter((segment) => segment.text.trim() !== "")
    .map((segment) => {
      const seconds = (segment.startMs / 1000).toFixed(1);
      const interrupted = segment.interrupted ? " [INTERRUMPIDO]" : "";
      return `[${seconds}s] ${segment.speaker}: ${segment.text.trim()}${interrupted}`;
    })
    .join("\n");
}
