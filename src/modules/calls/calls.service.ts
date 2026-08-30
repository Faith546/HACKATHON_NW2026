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
  type CallActorType,
  type CallLifecycleObserver,
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
  lifecycleObserver?: CallLifecycleObserver;
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

interface CampaignDispatchState {
  operationId: string;
  maxParallelCalls: number;
  pending: Array<{
    negotiationId: string;
    carrierId: string;
    phone: string;
  }>;
  activeCallIds: Set<string>;
  pumping: boolean;
}

export class CallsService implements CallScheduler {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly campaignDispatches = new Map<string, CampaignDispatchState>();
  private readonly campaignIdByCallId = new Map<string, string>();
  private readonly scheduledCampaignIds = new Set<string>();

  constructor(private readonly dependencies: CallsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId =
      dependencies.createId ?? (() => `call_${randomUUID()}`);
  }

  async enqueueOutbound(
    input: EnqueueOutboundCallInput,
    resolvedContext?: OutboundCallContext,
    beforeDispatch?: (call: Call) => void,
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
      actorType: "CARRIER",
      twilioCallSid: null,
      twilioStreamSid: null,
      recordingSid: null,
      recordingStatus: null,
      recordingUrl: null,
      recordingDurationSeconds: null,
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

    beforeDispatch?.(structuredClone(call));
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
        // Once Twilio accepted a call, a later persistence/audit failure must
        // never overwrite its live lifecycle as FAILED or trigger a redial.
        if (providerCallId !== null) return;
        const current = await this.dependencies.repository.findById(call.id);
        if (!current || terminalCallStatuses.has(current.status)) return;
        const endedAt = this.now().toISOString();
        const failed = await this.dependencies.repository.setStatus(
          call.id,
          "FAILED",
          endedAt,
        );
        try {
          await this.dependencies.auditWriter?.record({
            operationId,
            eventType: "CALL_FAILED",
            actorType: "SYSTEM",
            callId: call.id,
            entityType: "CALL",
            entityId: call.id,
            payload: {
              message:
                error instanceof Error ? error.message : String(error),
              providerCallId,
            },
          });
        } finally {
          try {
            await this.dependencies.lifecycleObserver?.onStatusChanged({
              call: failed,
              previousStatus: current.status,
              changed: true,
            });
          } finally {
            await this.releaseCampaignSlot(failed.id);
          }
        }
      },
    });

    return call;
  }

  async enqueueQuoteCalls(input: {
    operationId: string;
    campaignId: string;
    maxParallelCalls: number;
    negotiations: Array<{
      negotiationId: string;
      carrierId: string;
      phone: string;
    }>;
  }): Promise<void> {
    requiredIdentifier(input.campaignId, "campaignId");
    if (
      !Number.isInteger(input.maxParallelCalls) ||
      input.maxParallelCalls < 1 ||
      input.maxParallelCalls > 3
    ) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "maxParallelCalls debe ser un entero entre 1 y 3.",
        { field: "maxParallelCalls" },
      );
    }
    if (this.scheduledCampaignIds.has(input.campaignId)) return;
    const pending = input.negotiations.map((negotiation) => ({
      negotiationId: requiredIdentifier(
        negotiation.negotiationId,
        "negotiationId",
      ),
      carrierId: requiredIdentifier(negotiation.carrierId, "carrierId"),
      phone: requiredIdentifier(negotiation.phone, "phone"),
    }));
    this.scheduledCampaignIds.add(input.campaignId);
    this.campaignDispatches.set(input.campaignId, {
      operationId: requiredIdentifier(input.operationId, "operationId"),
      maxParallelCalls: input.maxParallelCalls,
      pending,
      activeCallIds: new Set(),
      pumping: false,
    });
    await this.pumpCampaign(input.campaignId);
  }

  private async pumpCampaign(campaignId: string): Promise<void> {
    const dispatch = this.campaignDispatches.get(campaignId);
    if (!dispatch || dispatch.pumping) return;
    dispatch.pumping = true;
    try {
      while (
        dispatch.activeCallIds.size < dispatch.maxParallelCalls &&
        dispatch.pending.length > 0
      ) {
        const negotiation = dispatch.pending.shift();
        if (!negotiation) break;
        await this.enqueueOutbound(
          {
            operationId: dispatch.operationId,
            carrierId: negotiation.carrierId,
            negotiationId: negotiation.negotiationId,
            purpose: "QUOTE",
          },
          { toNumber: negotiation.phone },
          (call) => {
            dispatch.activeCallIds.add(call.id);
            this.campaignIdByCallId.set(call.id, campaignId);
          },
        );
      }
    } finally {
      dispatch.pumping = false;
      if (
        dispatch.pending.length === 0 &&
        dispatch.activeCallIds.size === 0
      ) {
        this.campaignDispatches.delete(campaignId);
      }
    }
  }

  private async releaseCampaignSlot(callId: string): Promise<void> {
    const campaignId = this.campaignIdByCallId.get(callId);
    if (!campaignId) return;
    this.campaignIdByCallId.delete(callId);
    const dispatch = this.campaignDispatches.get(campaignId);
    if (!dispatch) return;
    dispatch.activeCallIds.delete(callId);
    await this.pumpCampaign(campaignId);
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

  async findByRecordingSid(recordingSid: string): Promise<Call | null> {
    return this.dependencies.repository.findByRecordingSid(
      requiredIdentifier(recordingSid, "recordingSid"),
    );
  }

  async updateRecording(callId: string, patch: Parameters<CallRepository["setRecording"]>[1]): Promise<Call> {
    await this.getById(callId);
    return this.dependencies.repository.setRecording(callId, patch);
  }

  async findByOperationPurpose(
    operationId: string,
    purpose: CallPurpose,
  ): Promise<Call | null> {
    return this.dependencies.repository.findByOperationPurpose(
      requiredIdentifier(operationId, "operationId"),
      purpose,
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
    try {
      return await this.dependencies.repository.setProviderCallId(
        callId,
        providerCallId,
      );
    } catch (error) {
      const owner =
        await this.dependencies.repository.findByProviderCallId(
          providerCallId,
        );
      if (owner && owner.id !== callId) {
        throw new ApiError(
          409,
          "CALL_PROVIDER_ID_CONFLICT",
          "El CallSid ya pertenece a otra llamada interna.",
          { callId, actualCallId: owner.id, providerCallId },
        );
      }
      throw error;
    }
  }

  async ensureStreamIdentity(
    callId: string,
    providerCallId: string,
    streamSid: string,
  ): Promise<Call> {
    requiredIdentifier(streamSid, "streamSid");
    const call = await this.ensureProviderCallId(callId, providerCallId);
    if (call.twilioStreamSid && call.twilioStreamSid !== streamSid) {
      throw new ApiError(409, "STREAM_ID_CONFLICT", "La llamada ya tiene otro StreamSid.", {
        callId, streamSid: call.twilioStreamSid,
      });
    }
    const owner = await this.dependencies.repository.findByStreamSid(streamSid);
    if (owner && owner.id !== callId) {
      throw new ApiError(409, "STREAM_ID_CONFLICT", "El StreamSid pertenece a otra llamada.", {
        callId, actualCallId: owner.id, streamSid,
      });
    }
    if (call.twilioStreamSid === streamSid) return call;
    try {
      return await this.dependencies.repository.setStreamSid(callId, streamSid);
    } catch (error) {
      const concurrent = await this.dependencies.repository.findByStreamSid(streamSid);
      if (concurrent && concurrent.id !== callId) {
        throw new ApiError(409, "STREAM_ID_CONFLICT", "El StreamSid pertenece a otra llamada.", {
          callId, actualCallId: concurrent.id, streamSid,
        });
      }
      throw error;
    }
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
      operationId: input.operationId
        ? requiredIdentifier(input.operationId, "operationId")
        : null,
      carrierId: input.carrierId?.trim() || null,
      negotiationId: input.negotiationId?.trim() || null,
      actorType: input.actorType,
      twilioCallSid: providerCallId,
      twilioStreamSid: null,
      recordingSid: null,
      recordingStatus: null,
      recordingUrl: null,
      recordingDurationSeconds: null,
      realtimeSessionId: null,
      direction: "INBOUND",
      purpose: input.purpose,
      status: "QUEUED",
      fromNumber: requiredIdentifier(input.fromNumber, "fromNumber"),
      toNumber: requiredIdentifier(input.toNumber, "toNumber"),
      transcript: null,
      brief: null,
      startedAt: null,
      endedAt: null,
      createdAt: this.now().toISOString(),
    };
    try {
      await this.dependencies.repository.insert(call);
    } catch (error) {
      const concurrent =
        await this.dependencies.repository.findByProviderCallId(
          providerCallId,
        );
      if (concurrent) return concurrent;
      throw error;
    }
    if (call.operationId) {
      await this.recordInboundCallReceived(call);
    }
    return call;
  }

  async bindOperationContext(
    callId: string,
    input: {
      operationId: string;
      purpose?: CallPurpose;
      actorType?: CallActorType;
    },
  ): Promise<Call> {
    const current = await this.getById(callId);
    const operationId = requiredIdentifier(input.operationId, "operationId");
    if (current.operationId && current.operationId !== operationId) {
      throw new ApiError(
        409,
        "CALL_OPERATION_CONTEXT_CONFLICT",
        "La llamada ya está vinculada con otra operación.",
        { callId, operationId: current.operationId },
      );
    }
    const updated = await this.dependencies.repository.bindContext(callId, {
      operationId,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.actorType ? { actorType: input.actorType } : {}),
    });
    if (!current.operationId) {
      await this.recordInboundCallReceived(updated);
      await this.dependencies.auditWriter?.record({
        operationId,
        eventType: "CALL_CONTEXT_LINKED",
        actorType:
          updated.actorType === "INTERNAL_OPERATOR"
            ? "INTERNAL_OPERATOR"
            : updated.actorType === "DRIVER"
              ? "DRIVER"
              : "CARRIER",
        actorId:
          updated.actorType === "INTERNAL_OPERATOR"
            ? updated.fromNumber
            : undefined,
        callId: updated.id,
        entityType: "CALL",
        entityId: updated.id,
        payload: { purpose: updated.purpose },
      });
    }
    return updated;
  }

  async linkRealtimeSession(
    callId: string,
    sessionId: string | null,
  ): Promise<Call> {
    await this.getById(callId);
    return this.dependencies.repository.setRealtimeSessionId(callId, sessionId);
  }

  async saveTranscript(
    callId: string,
    transcript: string,
    options: { audit?: boolean } = {},
  ): Promise<Call> {
    const call = await this.getById(callId);
    const updated = await this.dependencies.repository.saveTranscript(
      callId,
      transcript.trim(),
    );
    if (options.audit !== false && call.operationId) {
      await this.dependencies.auditWriter?.record({
        operationId: call.operationId,
        eventType: "TRANSCRIPT_SAVED",
        actorType: "SYSTEM",
        callId,
        entityType: "CALL",
        entityId: callId,
        payload: { characterCount: transcript.trim().length },
      });
    }
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
    if (current.status === nextStatus) {
      try {
        await this.dependencies.lifecycleObserver?.onStatusChanged({
          call: current,
          previousStatus: current.status,
          changed: false,
        });
      } finally {
        if (terminalCallStatuses.has(current.status)) {
          await this.releaseCampaignSlot(current.id);
        }
      }
      return { call: current, changed: false };
    }
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
    if (result.changed && result.call.operationId) {
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
    try {
      await this.dependencies.lifecycleObserver?.onStatusChanged({
        call: result.call,
        previousStatus: current.status,
        changed: result.changed,
      });
    } finally {
      if (terminalCallStatuses.has(result.call.status)) {
        await this.releaseCampaignSlot(result.call.id);
      }
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
    if (call.operationId) {
      await this.dependencies.auditWriter?.record({
        operationId: call.operationId,
        eventType: "CALL_BRIEF_SAVED",
        actorType:
          call.actorType === "INTERNAL_OPERATOR"
            ? "OPERATIONS_AGENT"
            : "LOGISTICS_AGENT",
        callId: call.id,
        entityType: "CALL",
        entityId: call.id,
        payload: { outcome: brief.outcome },
      });
    }
    return brief;
  }

  private async recordInboundCallReceived(call: Call): Promise<void> {
    if (!call.operationId) return;
    await this.dependencies.auditWriter?.record({
      operationId: call.operationId,
      eventType: "CALL_RECEIVED",
      actorType: "SYSTEM",
      callId: call.id,
      entityType: "CALL",
      entityId: call.id,
      payload: {
        providerCallId: call.twilioCallSid,
        actorType: call.actorType,
        carrierId: call.carrierId,
        fromNumber: call.fromNumber,
      },
    });
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
