import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../../shared/audit/audit-writer";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";
import type { CallPurpose } from "../calls/calls.types";
import type {
  VoiceCorePort,
  VoiceToolName,
} from "../voice/voice-core.port";
import { parseVoiceToolArguments } from "../voice/voice-tools";
import type { RealtimeSessionRepository } from "./realtime.repository";
import {
  type CreateRealtimeSessionInput,
  type RealtimeAgentType,
  type RealtimeMode,
  type RealtimeSession,
  type TranscriptSegment,
} from "./realtime.types";

const toolsByMode: Record<RealtimeMode, VoiceToolName[]> = {
  OPERATIONS: [
    "createOperation",
    "getOperationStatus",
    "listCarriers",
    "startCampaign",
    "saveCallBrief",
  ],
  QUOTE: [
    "getOperation",
    "getActiveMandate",
    "evaluateOffer",
    "recordQuote",
    "reportNoAnswer",
    "saveCallBrief",
  ],
  COMMIT: [
    "getOperation",
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
    "evaluateIncidentChange",
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

const mutatingVoiceTools = new Set<VoiceToolName>([
  "createOperation",
  "createMandate",
  "startCampaign",
  "cancelOperation",
  "evaluateOffer",
  "recordQuote",
  "reportNoAnswer",
  "recordVerbalAgreement",
  "attachCommitmentEvidence",
  "enqueueCommitmentSummary",
  "reportIncident",
  "evaluateIncidentChange",
  "requestEscalation",
  "confirmPickup",
  "confirmDelivery",
  "saveCallBrief",
]);

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
  private readonly connectionClosers = new Map<
    string,
    () => Promise<void> | void
  >();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly toolExecutionsBySession = new Map<
    string,
    Map<string, Promise<unknown>>
  >();

  constructor(private readonly dependencies: RealtimeServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? (() => `rts_${randomUUID()}`);
  }

  async create(input: CreateRealtimeSessionInput): Promise<RealtimeSession> {
    const call = await this.dependencies.callsService.getById(input.callId);
    if (!call.operationId && call.actorType !== "INTERNAL_OPERATOR") {
      throw new ApiError(
        422,
        "INBOUND_CONTEXT_UNRESOLVED",
        "No hay una operación activa para la llamada entrante.",
        { callId: call.id, carrierId: call.carrierId },
      );
    }
    this.assertMatchingContext("operationId", input.operationId, call.operationId);
    this.assertMatchingContext("carrierId", input.carrierId, call.carrierId);
    this.assertMatchingContext(
      "negotiationId",
      input.negotiationId,
      call.negotiationId,
    );
    const agent: RealtimeAgentType =
      call.actorType === "INTERNAL_OPERATOR"
        ? "OPERATIONS_AGENT"
        : "LOGISTICS_AGENT";
    if (input.actorType !== call.actorType) {
      throw new ApiError(
        422,
        "REALTIME_ACTOR_MISMATCH",
        "El actor Realtime no corresponde a la identidad validada de la llamada.",
        { requested: input.actorType, actual: call.actorType },
      );
    }
    if (input.mode !== modeForCallPurpose(call.purpose)) {
      throw new ApiError(
        422,
        "REALTIME_MODE_MISMATCH",
        "El modo Realtime no corresponde al propósito oficial de la llamada.",
        {
          callId: call.id,
          purpose: call.purpose,
          requestedMode: input.mode,
          expectedMode: modeForCallPurpose(call.purpose),
        },
      );
    }
    if (["COMPLETED", "BUSY", "NO_ANSWER", "FAILED"].includes(call.status)) {
      throw new ApiError(
        409,
        "CALL_NOT_ACTIVE",
        "No se puede abrir Realtime sobre una llamada terminal.",
        { callId: call.id, status: call.status },
      );
    }

    const existing = await this.dependencies.repository.findActiveByCallId(
      call.id,
    );
    if (existing) {
      if (existing.agent !== agent || existing.mode !== input.mode) {
        throw new ApiError(
          409,
          "REALTIME_SESSION_CONTEXT_CONFLICT",
          "La llamada ya tiene una sesión activa con otro agente o modo.",
          {
            sessionId: existing.id,
            existingAgent: existing.agent,
            existingMode: existing.mode,
          },
        );
      }
      return existing;
    }

    const mandate = call.operationId
      ? await this.dependencies.voiceCore.getActiveMandate(call.operationId)
      : null;
    const session: RealtimeSession = {
      id: this.createId(),
      callId: call.id,
      operationId: call.operationId,
      carrierId: call.carrierId,
      negotiationId: call.negotiationId,
      actorType: call.actorType,
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
    if (call.operationId) {
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
    }
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
    const transcript = consolidateTranscript(session.transcriptSegments);
    if (transcript) {
      await this.dependencies.callsService.saveTranscript(
        session.callId,
        transcript,
        { audit: false },
      );
    }
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
    const parsedArguments = parseVoiceToolArguments(name, argumentsValue);
    const trustedArguments =
      name === "attachCommitmentEvidence"
        ? deriveTranscriptEvidence(session, parsedArguments)
        : parsedArguments;
    const transcriptEvidence =
      name === "recordVerbalAgreement" ||
      name === "createOperation" ||
      name === "confirmDelivery"
        ? latestTranscriptEvidence(session)
        : name === "attachCommitmentEvidence"
          ? {
              startMs: trustedArguments.startMs as number,
              endMs: trustedArguments.endMs as number,
              transcriptExcerpt:
                trustedArguments.transcriptExcerpt as string,
            }
          : undefined;
    if (transcriptEvidence && name !== "createOperation") {
      assertExplicitVoiceAuthorization(name, transcriptEvidence);
    }
    const execute = () =>
      this.dependencies.voiceCore.executeVoiceTool({
        name,
        context: {
          callId: session.callId,
          operationId: session.operationId,
          carrierId: session.carrierId,
          negotiationId: session.negotiationId,
          actorType: session.actorType,
          mandateId: session.mandateId,
          ...(transcriptEvidence ? { transcriptEvidence } : {}),
        },
        arguments: trustedArguments,
      });
    if (!mutatingVoiceTools.has(name)) {
      const result = await execute();
      await this.synchronizeOperatorContext(session, name, result);
      return result;
    }

    const key = `${name}:${stableJson(trustedArguments)}`;
    const executions =
      this.toolExecutionsBySession.get(session.id) ?? new Map();
    this.toolExecutionsBySession.set(session.id, executions);
    const existing = executions.get(key);
    if (existing) return existing;
    const execution = execute();
    executions.set(key, execution);
    try {
      const result = await execution;
      await this.synchronizeOperatorContext(session, name, result);
      return result;
    } catch (error) {
      if (executions.get(key) === execution) executions.delete(key);
      throw error;
    }
  }

  registerConnectionCloser(
    sessionId: string,
    closer: () => Promise<void> | void,
  ): () => void {
    this.connectionClosers.set(sessionId, closer);
    return () => {
      if (this.connectionClosers.get(sessionId) === closer) {
        this.connectionClosers.delete(sessionId);
      }
    };
  }

  async close(sessionId: string): Promise<void> {
    const activeClose = this.closingSessions.get(sessionId);
    if (activeClose) return activeClose;
    const closing = this.closeSession(sessionId);
    this.closingSessions.set(sessionId, closing);
    try {
      await closing;
    } finally {
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const closeConnection = this.connectionClosers.get(sessionId);
    this.connectionClosers.delete(sessionId);
    let connectionCloseError: unknown = null;
    try {
      await closeConnection?.();
    } catch (error) {
      connectionCloseError = error;
    }
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
    if (session.operationId) {
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
    }
    await this.dependencies.repository.delete(session.id);
    this.toolExecutionsBySession.delete(session.id);
    if (connectionCloseError) throw connectionCloseError;
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

  private async synchronizeOperatorContext(
    session: RealtimeSession,
    name: VoiceToolName,
    _result: unknown,
  ): Promise<void> {
    if (
      session.actorType !== "INTERNAL_OPERATOR" ||
      (name !== "createOperation" && name !== "getOperationStatus")
    ) {
      return;
    }
    const call = await this.dependencies.callsService.getById(session.callId);
    if (!call.operationId) return;
    session.operationId = call.operationId;
    const mandate = await this.dependencies.voiceCore.getActiveMandate(
      call.operationId,
    );
    session.mandateId = mandate?.id ?? null;
    if (call.purpose === "DELIVERY") {
      session.mode = "DELIVERY";
      session.allowedTools = [...toolsByMode.DELIVERY];
    }
    await this.dependencies.repository.save(session);
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

export function modeForCallPurpose(purpose: CallPurpose): RealtimeMode {
  if (purpose === "OPERATIONS") return "OPERATIONS";
  if (purpose === "QUOTE" || purpose === "RENEGOTIATION") return "QUOTE";
  if (purpose === "COMMIT") return "COMMIT";
  if (purpose === "INCIDENT" || purpose === "ESCALATION") return "INCIDENT";
  if (purpose === "DELIVERY") return "DELIVERY";
  return "EXECUTION";
}

function deriveTranscriptEvidence(
  session: RealtimeSession,
  argumentsValue: Record<string, unknown>,
): Record<string, unknown> {
  const excerpt = String(argumentsValue.transcriptExcerpt ?? "").trim();
  const normalizedExcerpt = normalizeTranscriptText(excerpt);
  const candidates = [...session.transcriptSegments]
    .filter(
      (segment) =>
        segment.speaker === "HUMAN" &&
        segment.final &&
        !segment.interrupted,
    )
    .sort((left, right) => left.startMs - right.startMs);
  const matching = candidates.find((segment) =>
    normalizeTranscriptText(segment.text).includes(normalizedExcerpt),
  );
  if (!matching) {
    throw new ApiError(
      422,
      "TRANSCRIPT_EVIDENCE_NOT_FOUND",
      "El extracto no coincide con una intervención humana final del transcript.",
      { sessionId: session.id },
    );
  }
  return {
    transcriptExcerpt: excerpt,
    startMs: matching.startMs,
    endMs: matching.endMs,
  };
}

function latestTranscriptEvidence(session: RealtimeSession): {
  startMs: number;
  endMs: number;
  transcriptExcerpt: string;
} {
  const segment = [...session.transcriptSegments]
    .filter(
      (candidate) =>
        candidate.speaker === "HUMAN" &&
        candidate.final &&
        !candidate.interrupted &&
        candidate.text.trim() !== "",
    )
    .sort((left, right) => right.endMs - left.endMs)[0];
  if (!segment) {
    throw new ApiError(
      409,
      "TRANSCRIPT_EVIDENCE_REQUIRED",
      "No hay una confirmación humana final para respaldar el acuerdo.",
      { sessionId: session.id },
    );
  }
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    transcriptExcerpt: segment.text.trim(),
  };
}

function normalizeTranscriptText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-MX");
}

function assertExplicitVoiceAuthorization(
  name: VoiceToolName,
  evidence: { transcriptExcerpt: string },
): void {
  const text = normalizeTranscriptText(evidence.transcriptExcerpt);
  let accepted = true;
  if (name === "recordVerbalAgreement") {
    accepted =
      /\b(si|confirmo|confirma|acepto|acepta)\b/.test(text) &&
      !/\b(dejame|luego|despues|voy a confirmar)\b/.test(text);
  } else if (name === "confirmDelivery") {
    accepted =
      /\b(confirmo|confirma)\b/.test(text) &&
      /\b(entregado|entregada|entrego|entrega)\b/.test(text) &&
      !/\b(deberia|probablemente|tal vez|quiza)\b/.test(text);
  }
  if (!accepted) {
    throw new ApiError(
      409,
      "EXPLICIT_VOICE_CONFIRMATION_REQUIRED",
      "La última intervención humana no contiene una confirmación inequívoca para esta acción.",
      { tool: name },
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
