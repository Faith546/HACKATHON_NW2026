import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../../shared/audit/audit-writer";
import { ApiError } from "../../shared/http/api-error";
import type { InMemoryJobQueue } from "../../shared/queue/in-memory-job-queue";
import type { CallRepository } from "./calls.repository";
import {
  enqueueCallPurposes,
  type Call,
  type CallBrief,
  type CallBriefInput,
  type CallPurpose,
  type CallScheduler,
  type CallStatus,
  type CreateInboundCallInput,
  type EnqueueOutboundCallInput,
  type OutboundCallContext,
  type OutboundCallContextResolver,
  type TelephonyGateway,
} from "./calls.types";

export interface CallsServiceDependencies {
  repository: CallRepository;
  queue: InMemoryJobQueue;
  telephonyGateway: TelephonyGateway;
  contextResolver: OutboundCallContextResolver;
  auditWriter?: AuditWriter;
  now?: () => Date;
  createId?: () => string;
}

function requiredIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} es obligatorio.`, {
      field,
    });
  }
  return value.trim();
}

function persistedPurpose(purpose: EnqueueOutboundCallInput["purpose"]): CallPurpose {
  // OpenAPI exposes FOLLOW_UP while SQLite intentionally does not. For this
  // slice it uses the existing EXECUTION bucket without changing the schema.
  return purpose === "FOLLOW_UP" ? "EXECUTION" : purpose;
}

export class CallsService implements CallScheduler {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly dependencies: CallsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId =
      dependencies.createId ?? (() => `call_${randomUUID()}`);
  }

  async enqueueOutbound(
    input: EnqueueOutboundCallInput,
    resolvedContext?: OutboundCallContext,
  ): Promise<Call> {
    const operationId = requiredIdentifier(input.operationId, "operationId");
    const carrierId = requiredIdentifier(input.carrierId, "carrierId");
    if (!enqueueCallPurposes.includes(input.purpose)) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "purpose no es válido para una llamada saliente.",
        { field: "purpose" },
      );
    }

    const normalizedInput: EnqueueOutboundCallInput = {
      operationId,
      carrierId,
      negotiationId: input.negotiationId?.trim() || null,
      purpose: input.purpose,
    };
    const context =
      resolvedContext ??
      (await this.dependencies.contextResolver.resolve(normalizedInput));
    const call: Call = {
      id: this.createId(),
      operationId,
      carrierId,
      negotiationId: normalizedInput.negotiationId ?? null,
      twilioCallSid: null,
      realtimeSessionId: null,
      direction: "OUTBOUND",
      purpose: persistedPurpose(input.purpose),
      status: "QUEUED",
      fromNumber: null,
      toNumber: context.toNumber,
      transcript: null,
      brief: null,
      startedAt: null,
      endedAt: null,
      createdAt: this.now().toISOString(),
    };

    await this.dependencies.repository.insert(call);
    await this.dependencies.auditWriter?.record({
      operationId,
      eventType: "CALL_QUEUED",
      actorType: "SYSTEM",
      callId: call.id,
      entityType: "CALL",
      entityId: call.id,
      payload: {
        carrierId,
        negotiationId: call.negotiationId,
        purpose: call.purpose,
        requestedPurpose: input.purpose,
      },
    });

    let providerCallId: string | null = null;
    this.dependencies.queue.enqueue({
      id: call.id,
      run: async () => {
        if (providerCallId === null) {
          const result = await this.dependencies.telephonyGateway.startOutboundCall({
            callId: call.id,
            operationId,
            carrierId,
            negotiationId: call.negotiationId,
            purpose: call.purpose,
            toNumber: call.toNumber,
          });
          providerCallId = result.providerCallId;
        }
        await this.dependencies.repository.setProviderCallId(
          call.id,
          providerCallId,
        );
        await this.dependencies.auditWriter?.record({
          operationId,
          eventType: "CALL_DISPATCHED",
          actorType: "SYSTEM",
          callId: call.id,
          entityType: "CALL",
          entityId: call.id,
          payload: { providerCallId },
        });
      },
      onExhausted: async (error) => {
        const endedAt = this.now().toISOString();
        await this.dependencies.repository.setStatus(call.id, "FAILED", endedAt);
        await this.dependencies.auditWriter?.record({
          operationId,
          eventType: "CALL_FAILED",
          actorType: "SYSTEM",
          callId: call.id,
          entityType: "CALL",
          entityId: call.id,
          payload: {
            message: error instanceof Error ? error.message : String(error),
            providerCallId,
          },
        });
      },
    });

    return call;
  }

  async enqueueQuoteCalls(input: {
    operationId: string;
    campaignId: string;
    negotiations: Array<{
      negotiationId: string;
      carrierId: string;
      phone: string;
    }>;
  }): Promise<void> {
    requiredIdentifier(input.campaignId, "campaignId");
    for (const negotiation of input.negotiations) {
      await this.enqueueOutbound(
        {
          operationId: input.operationId,
          carrierId: negotiation.carrierId,
          negotiationId: negotiation.negotiationId,
          purpose: "QUOTE",
        },
        { toNumber: requiredIdentifier(negotiation.phone, "phone") },
      );
    }
  }

  async getById(callId: string): Promise<Call> {
    const call = await this.dependencies.repository.findById(callId);
    if (!call) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "La llamada no existe.", {
        callId,
      });
    }
    return call;
  }

  async findByProviderCallId(providerCallId: string): Promise<Call | null> {
    return this.dependencies.repository.findByProviderCallId(
      requiredIdentifier(providerCallId, "providerCallId"),
    );
  }

  async ensureProviderCallId(
    callId: string,
    providerCallId: string,
  ): Promise<Call> {
    const call = await this.getById(callId);
    if (call.twilioCallSid && call.twilioCallSid !== providerCallId) {
      throw new ApiError(
        409,
        "CALL_PROVIDER_ID_CONFLICT",
        "La llamada ya está asociada con otro CallSid.",
        { callId, providerCallId: call.twilioCallSid },
      );
    }
    if (call.twilioCallSid === providerCallId) return call;
    return this.dependencies.repository.setProviderCallId(callId, providerCallId);
  }

  async createOrGetInbound(input: CreateInboundCallInput): Promise<Call> {
    const providerCallId = requiredIdentifier(
      input.providerCallId,
      "providerCallId",
    );
    const existing = await this.dependencies.repository.findByProviderCallId(
      providerCallId,
    );
    if (existing) return existing;

    const call: Call = {
      id: this.createId(),
      operationId: requiredIdentifier(input.operationId, "operationId"),
      carrierId: input.carrierId?.trim() || null,
      negotiationId: input.negotiationId?.trim() || null,
      twilioCallSid: providerCallId,
      realtimeSessionId: null,
      direction: "INBOUND",
      purpose: input.purpose,
      status: input.status ?? "QUEUED",
      fromNumber: requiredIdentifier(input.fromNumber, "fromNumber"),
      toNumber: requiredIdentifier(input.toNumber, "toNumber"),
      transcript: null,
      brief: null,
      startedAt: null,
      endedAt: null,
      createdAt: this.now().toISOString(),
    };
    await this.dependencies.repository.insert(call);
    await this.dependencies.auditWriter?.record({
      operationId: call.operationId,
      eventType: "CALL_RECEIVED",
      actorType: "SYSTEM",
      callId: call.id,
      entityType: "CALL",
      entityId: call.id,
      payload: {
        providerCallId,
        carrierId: call.carrierId,
        fromNumber: call.fromNumber,
      },
    });
    return call;
  }

  async linkRealtimeSession(
    callId: string,
    sessionId: string | null,
  ): Promise<Call> {
    await this.getById(callId);
    return this.dependencies.repository.setRealtimeSessionId(callId, sessionId);
  }

  async saveTranscript(callId: string, transcript: string): Promise<Call> {
    const call = await this.getById(callId);
    const updated = await this.dependencies.repository.saveTranscript(
      callId,
      transcript.trim(),
    );
    await this.dependencies.auditWriter?.record({
      operationId: call.operationId,
      eventType: "TRANSCRIPT_SAVED",
      actorType: "SYSTEM",
      callId,
      entityType: "CALL",
      entityId: callId,
      payload: { characterCount: transcript.trim().length },
    });
    return updated;
  }

  async applyProviderStatus(
    providerCallId: string,
    nextStatus: CallStatus,
  ): Promise<{ call: Call; changed: boolean }> {
    const current = await this.findByProviderCallId(providerCallId);
    if (!current) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "No existe una llamada para el CallSid recibido.",
        { providerCallId },
      );
    }
    if (current.status === nextStatus) return { call: current, changed: false };
    if (!isAllowedStatusTransition(current.status, nextStatus)) {
      return { call: current, changed: false };
    }

    const occurredAt = this.now().toISOString();
    const terminal = terminalCallStatuses.has(nextStatus);
    const result = await this.dependencies.repository.transitionStatusByProviderCallId(
      providerCallId,
      {
        expectedStatus: current.status,
        status: nextStatus,
        ...(nextStatus === "IN_PROGRESS" && current.startedAt === null
          ? { startedAt: occurredAt }
          : {}),
        ...(terminal ? { endedAt: occurredAt } : {}),
      },
    );
    if (!result) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "La llamada no existe.");
    }
    if (result.changed) {
      await this.dependencies.auditWriter?.record({
        operationId: result.call.operationId,
        eventType: statusAuditEvent(nextStatus),
        actorType: "SYSTEM",
        callId: result.call.id,
        entityType: "CALL",
        entityId: result.call.id,
        payload: { previousStatus: current.status, status: nextStatus },
      });
    }
    return result;
  }

  async saveBrief(callId: string, input: CallBriefInput): Promise<CallBrief> {
    const call = await this.getById(callId);
    const brief: CallBrief = {
      ...input,
      objections: input.objections ?? [],
      nextSteps: input.nextSteps ?? [],
      callId: call.id,
      generatedAt: this.now().toISOString(),
    };
    await this.dependencies.repository.saveBrief(call.id, brief);
    await this.dependencies.auditWriter?.record({
      operationId: call.operationId,
      eventType: "CALL_BRIEF_SAVED",
      actorType: "LOGISTICS_AGENT",
      callId: call.id,
      entityType: "CALL",
      entityId: call.id,
      payload: { outcome: brief.outcome },
    });
    return brief;
  }
}

const terminalCallStatuses = new Set<CallStatus>([
  "COMPLETED",
  "BUSY",
  "NO_ANSWER",
  "FAILED",
]);

function isAllowedStatusTransition(
  current: CallStatus,
  next: CallStatus,
): boolean {
  if (terminalCallStatuses.has(current)) return false;
  if (terminalCallStatuses.has(next)) return true;
  const order: Record<Exclude<CallStatus, "COMPLETED" | "BUSY" | "NO_ANSWER" | "FAILED">, number> = {
    QUEUED: 0,
    RINGING: 1,
    IN_PROGRESS: 2,
  };
  return order[next as keyof typeof order] > order[current as keyof typeof order];
}

function statusAuditEvent(status: CallStatus): string {
  if (status === "IN_PROGRESS") return "CALL_STARTED";
  if (status === "COMPLETED") return "CALL_COMPLETED";
  if (status === "FAILED" || status === "BUSY" || status === "NO_ANSWER") {
    return "CALL_FAILED";
  }
  return "CALL_STATUS_CHANGED";
}
