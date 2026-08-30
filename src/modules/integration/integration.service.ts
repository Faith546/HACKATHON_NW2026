import { db } from "../../db";
import { auditEvents, campaigns, operations } from "../../db/schema";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";
import type {
  CallBriefInput,
  CallLifecycleObserver,
} from "../calls/calls.types";
import {
  campaignsService as defaultCampaignsService,
  type CampaignsService,
} from "../campaigns/campaigns.service";
import {
  carriersService as defaultCarriersService,
  type CarriersService,
} from "../carriers/carriers.service";
import {
  commitmentsService as defaultCommitmentsService,
  type CommitmentsService,
} from "../commitments/commitments.service";
import {
  toCommitmentResponse,
  type AttachEvidenceInput,
  type CommitmentRecord,
  type SendSummaryInput,
  type VerbalAgreementInput,
} from "../commitments/commitments.types";
import {
  escalationsService as defaultEscalationsService,
  type EscalationsService,
} from "../escalations/escalations.service";
import type { RequestEscalationInput } from "../escalations/escalations.types";
import {
  executionService as defaultExecutionService,
  type ExecutionService,
} from "../execution/execution.service";
import type {
  ConfirmDeliveryInput,
  ConfirmExecutionEventInput,
} from "../execution/execution.types";
import {
  incidentsService as defaultIncidentsService,
  type IncidentsService,
} from "../incidents/incidents.service";
import type {
  EvaluateChangeInput,
  ReportIncidentInput,
} from "../incidents/incidents.types";
import {
  mandatesService as defaultMandatesService,
  type MandatesService,
} from "../mandates/mandates.service";
import {
  marketService as defaultMarketService,
  type MarketService,
} from "../market/market.service";
import type {
  EvaluateQuoteInput,
  GroundedSaveQuoteInput,
} from "../market/market.types";
import {
  operationsService as defaultOperationsService,
  type OperationsService,
} from "../operations/operations.service";
import type {
  CancelOperationInput,
  CreateOperationInput,
  OperationResponse,
} from "../operations/operations.types";
import { DrizzleVoiceCoreAdapter } from "../voice/drizzle-voice-core.adapter";
import type {
  InboundCallResolution,
  VoiceToolContext,
  VoiceToolName,
} from "../voice/voice-core.port";
import { parseVoiceToolArguments } from "../voice/voice-tools";

interface InboundContextResolver {
  resolveInboundCallContext(input: {
    fromNumber: string;
    toNumber: string;
  }): Promise<InboundCallResolution>;
}

export interface IntegrationServiceDependencies {
  operationsService?: OperationsService;
  mandatesService?: MandatesService;
  carriersService?: CarriersService;
  campaignsService?: CampaignsService;
  marketService?: MarketService;
  commitmentsService?: CommitmentsService;
  incidentsService?: IncidentsService;
  escalationsService?: EscalationsService;
  executionService?: ExecutionService;
  callsService?: CallsService;
  inboundContextResolver?: InboundContextResolver;
  humanEscalationPhone?: string | null;
}

/**
 * In-process facade shared by HTTP and Realtime.
 *
 * It delegates every state transition to the official domain services. The
 * voice runtime supplies trusted call context; tool arguments only provide
 * business facts and can never substitute operation/carrier/call identifiers.
 */
export class IntegrationService {
  private readonly operationsService: OperationsService;
  private readonly mandatesService: MandatesService;
  private readonly carriersService: CarriersService;
  private readonly campaignsService: CampaignsService;
  private readonly marketService: MarketService;
  private readonly commitmentsService: CommitmentsService;
  private readonly incidentsService: IncidentsService;
  private readonly escalationsService: EscalationsService;
  private readonly executionService: ExecutionService;
  private readonly callsService?: CallsService;
  private readonly inboundContextResolver: InboundContextResolver;
  private readonly humanEscalationPhone: string | null;
  private readonly advancingOperations = new Map<string, Promise<unknown>>();
  private readonly creatingOperations = new Map<string, Promise<unknown>>();

  constructor(dependencies: IntegrationServiceDependencies = {}) {
    this.operationsService =
      dependencies.operationsService ?? defaultOperationsService;
    this.mandatesService =
      dependencies.mandatesService ?? defaultMandatesService;
    this.carriersService =
      dependencies.carriersService ?? defaultCarriersService;
    this.campaignsService =
      dependencies.campaignsService ?? defaultCampaignsService;
    this.marketService = dependencies.marketService ?? defaultMarketService;
    this.commitmentsService =
      dependencies.commitmentsService ?? defaultCommitmentsService;
    this.incidentsService =
      dependencies.incidentsService ?? defaultIncidentsService;
    this.escalationsService =
      dependencies.escalationsService ?? defaultEscalationsService;
    this.executionService =
      dependencies.executionService ?? defaultExecutionService;
    this.callsService = dependencies.callsService;
    this.inboundContextResolver =
      dependencies.inboundContextResolver ?? new DrizzleVoiceCoreAdapter(db);
    this.humanEscalationPhone =
      dependencies.humanEscalationPhone?.trim() ||
      process.env.HUMAN_ESCALATION_PHONE?.trim() ||
      null;
  }

  async resolveInboundCall(phoneNumber: string) {
    try {
      return await this.inboundContextResolver.resolveInboundCallContext({
        fromNumber: phoneNumber,
        toNumber: "",
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "INBOUND_CALLER_UNKNOWN"
      ) {
        return null;
      }
      throw error;
    }
  }

  getActiveMandate(operationId: string) {
    return this.mandatesService.getActiveMandate(operationId);
  }

  evaluateOffer(
    negotiationId: string,
    input: EvaluateQuoteInput,
    actorId?: string,
  ) {
    return this.marketService.evaluateOffer(negotiationId, input, actorId);
  }

  recordQuote(
    negotiationId: string,
    input: GroundedSaveQuoteInput,
    actorId?: string,
  ) {
    return this.marketService.recordQuote(negotiationId, input, actorId);
  }

  getAuthorizedCommitment(operationId: string) {
    return this.commitmentsService.getAuthorizedCommitment(operationId);
  }

  recordVerbalAgreement(
    commitmentId: string,
    input: VerbalAgreementInput,
    actorId?: string,
  ) {
    return this.commitmentsService.recordVerbalAgreement(
      commitmentId,
      input,
      actorId,
    );
  }

  confirmPickup(
    operationId: string,
    input: ConfirmExecutionEventInput,
    actorId?: string,
  ) {
    return this.executionService.confirmPickup(operationId, input, actorId);
  }

  confirmDelivery(
    operationId: string,
    input: ConfirmDeliveryInput,
    actorId?: string,
  ) {
    return this.executionService.confirmDelivery(operationId, input, actorId);
  }

  evaluateIncidentChange(
    incidentId: string,
    input: EvaluateChangeInput,
    actorId?: string,
  ) {
    return this.incidentsService.evaluateChange(incidentId, input, actorId);
  }

  async executeVoiceTool(input: {
    name: VoiceToolName;
    context: VoiceToolContext;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    const args = parseVoiceToolArguments(input.name, input.arguments);
    const actorId = `voice:${input.context.callId}`;

    switch (input.name) {
      case "createOperation":
        this.requireInternalOperator(input.context);
        return this.createOperationAutonomously(
          input.context,
          args as CreateOperationInput,
          actorId,
        );
      case "createMandate":
        return this.mandatesService.createMandateVersion(
          requireOperationId(input.context),
          args as Parameters<MandatesService["createMandateVersion"]>[1],
          actorId,
        );
      case "getOperationStatus": {
        const operationId = input.context.operationId;
        if (operationId) {
          return this.operationsService.getOperationStatus(operationId);
        }
        this.requireInternalOperator(input.context);
        const reference = args as {
          operationId?: string;
          containerNumber?: string;
        };
        const operation = await this.operationsService.resolveOperationReference(
          reference,
        );
        await this.requireCallsService().bindOperationContext(
          input.context.callId,
          {
            operationId: operation.id,
            purpose:
              operation.status === "IN_TRANSIT" ? "DELIVERY" : "OPERATIONS",
            actorType: "INTERNAL_OPERATOR",
          },
        );
        return this.operationsService.getOperationStatus(operation.id);
      }
      case "listCarriers":
        return this.carriersService.listCarriers();
      case "startCampaign":
        return this.campaignsService.startCampaign(
          requireOperationId(input.context),
          args as Parameters<CampaignsService["startCampaign"]>[1],
          actorId,
        );
      case "getQuotes":
        return this.marketService.listOperationQuotes(
          requireOperationId(input.context),
        );
      case "getCommitments": {
        const commitments = await this.commitmentsService.listCommitments(
          requireOperationId(input.context),
        );
        return commitments.map(toCommitmentResponse);
      }
      case "cancelOperation":
        return this.operationsService.cancelOperation(
          requireOperationId(input.context),
          args as CancelOperationInput,
          actorId,
        );
      case "getActiveMandate":
        return this.getActiveMandate(requireOperationId(input.context));
      case "evaluateOffer":
        return this.evaluateOffer(
          requireNegotiationId(input.context),
          args as EvaluateQuoteInput,
          actorId,
        );
      case "recordQuote": {
        const operationId = requireOperationId(input.context);
        const quote = await this.recordQuote(
          requireNegotiationId(input.context),
          {
            ...(args as Omit<GroundedSaveQuoteInput, "callId" | "grounding">),
            callId: input.context.callId,
            grounding: input.context.quoteGrounding,
          },
          actorId,
        );
        await this.advanceAutonomousFlow(operationId);
        return quote;
      }
      case "reportNoAnswer": {
        const operationId = requireOperationId(input.context);
        const campaign = await this.campaignsService.reportNoAnswer(
          requireNegotiationId(input.context),
        );
        await this.advanceAutonomousFlow(operationId);
        return campaign;
      }
      case "getAuthorizedCommitment": {
        const commitment = await this.getAuthorizedCommitment(
          requireOperationId(input.context),
        );
        return commitment ? toCommitmentResponse(commitment) : null;
      }
      case "recordVerbalAgreement": {
        const commitment = await this.requireActiveCommitment(
          input.context,
        );
        let updated = await this.recordVerbalAgreement(
          commitment.id,
          {
            ...(args as Omit<VerbalAgreementInput, "callId">),
            callId: input.context.callId,
          },
          actorId,
        );
        if (input.context.transcriptEvidence) {
          updated = await this.commitmentsService.attachEvidence(
            updated.id,
            {
              callId: input.context.callId,
              ...input.context.transcriptEvidence,
            },
            actorId,
          );
          updated = await this.enqueueCanonicalSummary(
            updated,
            "SMS",
            actorId,
          );
        }
        return toCommitmentResponse(updated);
      }
      case "attachCommitmentEvidence": {
        const commitment = await this.requireActiveCommitment(
          input.context,
        );
        if (commitment.evidenceStartMs !== null) {
          return toCommitmentResponse(commitment);
        }
        return toCommitmentResponse(
          await this.commitmentsService.attachEvidence(
            commitment.id,
            {
              ...(args as Omit<AttachEvidenceInput, "callId">),
              callId: input.context.callId,
            },
            actorId,
          ),
        );
      }
      case "enqueueCommitmentSummary": {
        const commitment = await this.requireActiveCommitment(
          input.context,
        );
        if (
          commitment.status === "SUMMARY_PENDING" ||
          commitment.status === "SUMMARY_SENT" ||
          commitment.status === "VALID"
        ) {
          return toCommitmentResponse(commitment);
        }
        const channel = "SMS" as const;
        return toCommitmentResponse(
          await this.enqueueCanonicalSummary(commitment, channel, actorId),
        );
      }
      case "getOperation":
        return this.operationsService.getOperation(
          requireOperationId(input.context),
        );
      case "reportIncident":
        return this.incidentsService.reportIncident(
          requireOperationId(input.context),
          {
            ...(args as Omit<ReportIncidentInput, "callId">),
            callId: input.context.callId,
          },
          actorId,
        );
      case "evaluateIncidentChange": {
        const { incidentId, ...details } = args as {
          incidentId: string;
        } & EvaluateChangeInput;
        this.assertIncidentContext(
          incidentId,
          requireOperationId(input.context),
        );
        return this.evaluateIncidentChange(incidentId, details, actorId);
      }
      case "requestEscalation": {
        const humanPhone = this.humanEscalationPhone;
        const request = {
          ...(args as Omit<RequestEscalationInput, "callId">),
          callId: input.context.callId,
          ...(humanPhone ? { requestedHumanPhone: humanPhone } : {}),
        };
        if (humanPhone && !/^\+[1-9]\d{7,14}$/.test(humanPhone)) {
          throw new ApiError(
            503,
            "HUMAN_ESCALATION_PHONE_INVALID",
            "HUMAN_ESCALATION_PHONE debe usar formato E.164.",
          );
        }
        const escalation = this.escalationsService.requestEscalation(
          requireOperationId(input.context),
          request,
          actorId,
        );
        if (!humanPhone) return escalation;
        return this.escalationsService.joinHuman(
          escalation.id,
          { humanPhone },
          actorId,
        );
      }
      case "confirmPickup":
        return this.confirmPickup(
          requireOperationId(input.context),
          {
            ...(args as Omit<ConfirmExecutionEventInput, "callId">),
            callId: input.context.callId,
          },
          actorId,
        );
      case "confirmDelivery":
        return this.executionService.confirmDelivery(
          requireOperationId(input.context),
          {
            ...(args as Omit<ConfirmDeliveryInput, "callId">),
            callId: input.context.callId,
          },
          actorId,
          input.context.actorType === "INTERNAL_OPERATOR"
            ? "INTERNAL_OPERATOR"
            : "DRIVER",
        );
      case "saveCallBrief": {
        const brief = await this.requireCallsService().saveBrief(
          input.context.callId,
          args as unknown as CallBriefInput,
        );
        if (
          input.context.negotiationId &&
          (brief.outcome === "REFUSED" || brief.outcome === "NO_AGREEMENT")
        ) {
          await this.campaignsService.reportRefused(
            input.context.negotiationId,
            actorId,
          );
          await this.advanceAutonomousFlow(
            requireOperationId(input.context),
          );
        }
        return brief;
      }
    }
  }

  /**
   * Resumes sourcing operations after process restarts. Every step first reads
   * persisted state, so replaying this method cannot create duplicate effects.
   */
  async recoverAutonomousFlows(): Promise<void> {
    const operationRows = db
      .selectDistinct({ id: operations.id, status: operations.status })
      .from(operations)
      .innerJoin(
        auditEvents,
        and(
          eq(auditEvents.operationId, operations.id),
          eq(auditEvents.eventType, "OPERATION_CREATED"),
          like(auditEvents.actorId, "voice:%"),
        ),
    )
      .where(inArray(operations.status, ["CREATED", "SOURCING"]))
      .all();
    for (const operation of operationRows) {
      try {
        if (operation.status === "CREATED") {
          await this.startAutomaticCampaign(
            operation.id,
            "system:autonomous-recovery",
          );
        } else {
          await this.advanceAutonomousFlow(operation.id);
        }
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code ===
            "AUTONOMOUS_CAMPAIGN_REQUIRES_EXACTLY_THREE_CARRIERS"
        ) {
          process.stderr.write(
            `[AUTONOMOUS_RECOVERY_SKIPPED] operationId=${operation.id} code=${error.code}\n`,
          );
          continue;
        }
        throw error;
      }
    }
  }

  async advanceAutonomousFlow(operationId: string): Promise<unknown> {
    const existing = this.advancingOperations.get(operationId);
    if (existing) return existing;
    const advancing = this.advanceAutonomousFlowOnce(operationId).finally(
      () => {
        if (this.advancingOperations.get(operationId) === advancing) {
          this.advancingOperations.delete(operationId);
        }
      },
    );
    this.advancingOperations.set(operationId, advancing);
    return advancing;
  }

  private requireInternalOperator(context: VoiceToolContext): void {
    if (context.actorType !== "INTERNAL_OPERATOR") {
      throw new ApiError(
        403,
        "INTERNAL_OPERATOR_REQUIRED",
        "Esta acción requiere una llamada de un operador interno autorizado.",
        { callId: context.callId },
      );
    }
  }

  private async createOperationAutonomously(
    context: VoiceToolContext,
    input: CreateOperationInput,
    actorId: string,
  ): Promise<unknown> {
    const key = input.containerNumber.trim().toLocaleUpperCase("es-MX");
    while (this.creatingOperations.has(key)) {
      await this.creatingOperations.get(key);
    }
    const creating = this.createOperationAutonomouslyOnce(
      context,
      input,
      actorId,
    ).finally(() => {
      if (this.creatingOperations.get(key) === creating) {
        this.creatingOperations.delete(key);
      }
    });
    this.creatingOperations.set(key, creating);
    return creating;
  }

  private async createOperationAutonomouslyOnce(
    context: VoiceToolContext,
    input: CreateOperationInput,
    actorId: string,
  ): Promise<unknown> {
    let operation: OperationResponse;
    try {
      operation = await this.operationsService.resolveOperationReference({
        containerNumber: input.containerNumber,
      });
      assertEquivalentOperation(operation, input);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      try {
        operation = await this.operationsService.createOperation(input, actorId);
      } catch (createError) {
        // A concurrent process can create the same command first. Resolve it
        // and verify the complete command before reusing it.
        try {
          operation = await this.operationsService.resolveOperationReference({
            containerNumber: input.containerNumber,
          });
          assertEquivalentOperation(operation, input);
        } catch {
          throw createError;
        }
      }
    }

    await this.requireCallsService().bindOperationContext(context.callId, {
      operationId: operation.id,
      purpose: "OPERATIONS",
      actorType: "INTERNAL_OPERATOR",
    });

    const latestCampaign = latestCampaignForOperation(operation.id);
    let campaign = latestCampaign
      ? await this.campaignsService.getCampaign(
          operation.id,
          latestCampaign.id,
        )
      : null;
    if (!campaign) {
      campaign = await this.startAutomaticCampaign(operation.id, actorId);
    }
    return {
      operation: await this.operationsService.getOperation(operation.id),
      campaign,
    };
  }

  private async startAutomaticCampaign(
    operationId: string,
    actorId: string,
  ) {
    const activeCarriers = (await this.carriersService.listCarriers()).filter(
      (carrier) => carrier.active,
    );
    if (activeCarriers.length !== 3) {
      throw new ApiError(
        409,
        "AUTONOMOUS_CAMPAIGN_REQUIRES_EXACTLY_THREE_CARRIERS",
        "La campaña automática requiere exactamente tres carriers activos.",
        { activeCarrierIds: activeCarriers.map((carrier) => carrier.id) },
      );
    }
    return this.campaignsService.startCampaign(
      operationId,
      {
        carrierIds: activeCarriers.map((carrier) => carrier.id),
        maxParallelCalls: 3,
      },
      actorId,
    );
  }

  private async advanceAutonomousFlowOnce(
    operationId: string,
  ): Promise<unknown> {
    const campaign = latestCampaignForOperation(operationId);
    if (!campaign) return null;
    if (campaign.status === "FAILED") return campaign;
    if (
      campaign.status !== "READY_TO_SELECT" &&
      campaign.status !== "COMPLETED"
    ) {
      return campaign;
    }

    let winningQuoteId = campaign.winningQuoteId;
    let carrierId: string | null = null;
    if (campaign.status === "READY_TO_SELECT") {
      const selection = await this.marketService.selectMarketWinner(
        operationId,
        { strategy: "LOWEST_VALID_TOTAL" },
        "system:autonomous-market",
      );
      winningQuoteId = selection.winningQuoteId;
      carrierId = selection.carrierId;
    }
    if (!winningQuoteId) {
      throw new ApiError(
        500,
        "CAMPAIGN_WINNER_INVARIANT_VIOLATION",
        "La campaña completada no tiene una cotización ganadora.",
        { operationId, campaignId: campaign.id },
      );
    }

    let commitment = await this.commitmentsService.getAuthorizedCommitment(
      operationId,
    );
    if (!commitment) {
      commitment = await this.commitmentsService.authorizeCommitment(
        operationId,
        { winningQuoteId },
        "system:autonomous-market",
      );
    }
    carrierId = carrierId ?? commitment.carrierId;

    const callsService = this.requireCallsService();
    const existingCall = await callsService.findByOperationPurpose(
      operationId,
      "COMMIT",
    );
    const commitCall =
      existingCall ??
      (await callsService.enqueueOutbound({
        operationId,
        carrierId,
        purpose: "COMMIT",
      }));
    return {
      selection: { winningQuoteId, carrierId },
      commitment: toCommitmentResponse(commitment),
      commitCall,
    };
  }

  private requireCallsService(): CallsService {
    if (!this.callsService) {
      throw new ApiError(
        503,
        "VOICE_RUNTIME_UNAVAILABLE",
        "El facade no recibió el servicio compartido de llamadas.",
      );
    }
    return this.callsService;
  }

  private async enqueueCanonicalSummary(
    commitment: CommitmentRecord,
    channel: "SMS",
    actorId: string,
  ): Promise<CommitmentRecord> {
    const operation = await this.operationsService.getOperation(
      commitment.operationId,
    );
    const carrier = (await this.carriersService.listCarriers()).find(
      (candidate) => candidate.id === commitment.carrierId,
    );
    if (!carrier) {
      throw new ApiError(
        409,
        "COMMITMENT_CARRIER_UNAVAILABLE",
        "El carrier del commitment ya no está disponible.",
        { commitmentId: commitment.id },
      );
    }
    const recipient = carrier.phone;
    if (!recipient) {
      throw new ApiError(
        422,
        "SUMMARY_RECIPIENT_UNAVAILABLE",
        `El carrier no tiene contacto oficial para ${channel}.`,
        { carrierId: carrier.id, channel },
      );
    }
    const summary: SendSummaryInput = {
      channel,
      recipient,
      message: canonicalCommitmentSummary(operation, commitment),
    };
    return this.commitmentsService.enqueueSummary(
      commitment.id,
      summary,
      actorId,
    );
  }

  private async requireActiveCommitment(
    context: VoiceToolContext,
  ): Promise<CommitmentRecord> {
    const operationId = requireOperationId(context);
    const commitment = await this.getAuthorizedCommitment(
      operationId,
    );
    if (!commitment) {
      throw new ApiError(
        409,
        "AUTHORIZED_COMMITMENT_REQUIRED",
        "La operación no tiene un commitment activo autorizado.",
        { operationId },
      );
    }
    if (context.carrierId && commitment.carrierId !== context.carrierId) {
      throw new ApiError(
        422,
        "COMMITMENT_CONTEXT_MISMATCH",
        "El commitment no pertenece al carrier de la llamada.",
        { commitmentId: commitment.id, carrierId: context.carrierId },
      );
    }
    return commitment;
  }

  private assertIncidentContext(
    incidentId: string,
    operationId: string,
  ): void {
    const incident = this.incidentsService.getIncident(incidentId);
    if (!incident) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Incidencia no encontrada.",
        { incidentId },
      );
    }
    if (incident.operationId !== operationId) {
      throw new ApiError(
        422,
        "INCIDENT_CONTEXT_MISMATCH",
        "La incidencia no pertenece a la operación de la llamada.",
        { incidentId, operationId },
      );
    }
  }
}

function requireNegotiationId(context: VoiceToolContext): string {
  if (!context.negotiationId) {
    throw new ApiError(
      409,
      "NEGOTIATION_CONTEXT_REQUIRED",
      "La llamada no tiene una negociación asociada.",
      { callId: context.callId },
    );
  }
  return context.negotiationId;
}

function requireOperationId(context: VoiceToolContext): string {
  if (!context.operationId) {
    throw new ApiError(
      409,
      "OPERATION_CONTEXT_REQUIRED",
      "La llamada todavía no está vinculada con una operación.",
      { callId: context.callId },
    );
  }
  return context.operationId;
}

function latestCampaignForOperation(operationId: string) {
  return (
    db
      .select()
      .from(campaigns)
      .where(eq(campaigns.operationId, operationId))
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(1)
      .get() ?? null
  );
}

function assertEquivalentOperation(
  operation: OperationResponse,
  input: CreateOperationInput,
): void {
  const mismatchedFields: string[] = [];
  if (operation.customerName !== input.customerName) {
    mismatchedFields.push("customerName");
  }
  if (operation.origin !== input.origin) mismatchedFields.push("origin");
  if (operation.destination !== input.destination) {
    mismatchedFields.push("destination");
  }
  if (operation.service !== input.service) mismatchedFields.push("service");
  if ((operation.notes ?? undefined) !== (input.notes ?? undefined)) {
    mismatchedFields.push("notes");
  }
  if (operation.mandate.maxTotalPrice !== input.mandate.maxTotalPrice) {
    mismatchedFields.push("mandate.maxTotalPrice");
  }
  if (operation.mandate.currency !== input.mandate.currency) {
    mismatchedFields.push("mandate.currency");
  }
  if (operation.mandate.pickupDate !== input.mandate.pickupDate) {
    mismatchedFields.push("mandate.pickupDate");
  }
  if (
    (operation.mandate.notes ?? undefined) !==
    (input.mandate.notes ?? undefined)
  ) {
    mismatchedFields.push("mandate.notes");
  }
  if (mismatchedFields.length > 0) {
    throw new ApiError(
      409,
      "OPERATION_COMMAND_CONFLICT",
      "El contenedor ya existe con datos diferentes; no se reutilizó la operación.",
      { operationId: operation.id, mismatchedFields },
    );
  }
}

function canonicalCommitmentSummary(
  operation: OperationResponse,
  commitment: CommitmentRecord,
): string {
  const totalPrice = new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(commitment.totalPriceCents / 100);
  return [
    `Confirmamos la operación ${operation.id}.`,
    `Contenedor ${operation.containerNumber}: ${operation.origin} → ${operation.destination}.`,
    `Pickup ${commitment.pickupDate}.`,
    `Total ${totalPrice} ${commitment.currency}.`,
  ].join(" ");
}

export function createCampaignCallLifecycleObserver(
  service: CampaignsService = defaultCampaignsService,
  onNegotiationTerminal?: (operationId: string) => Promise<void>,
): CallLifecycleObserver {
  return {
    async onStatusChanged({ call }) {
      if (
        !call.negotiationId ||
        (call.purpose !== "QUOTE" && call.purpose !== "RENEGOTIATION")
      ) {
        return;
      }
      if (call.status === "RINGING") {
        await service.markNegotiationCalling(call.negotiationId);
      } else if (call.status === "IN_PROGRESS") {
        await service.markNegotiationInProgress(call.negotiationId);
      } else if (
        call.status === "NO_ANSWER" ||
        call.status === "BUSY" ||
        call.status === "FAILED"
      ) {
        await service.reportNoAnswer(call.negotiationId);
        await onNegotiationTerminal?.(requireCallOperationId(call));
      }
    },
  };
}

function requireCallOperationId(call: { id: string; operationId: string | null }) {
  if (!call.operationId) {
    throw new ApiError(
      500,
      "CALL_OPERATION_INVARIANT_VIOLATION",
      "La llamada de negociación no está vinculada con una operación.",
      { callId: call.id },
    );
  }
  return call.operationId;
}

export function createIntegrationService(
  dependencies: IntegrationServiceDependencies = {},
): IntegrationService {
  return new IntegrationService(dependencies);
}

export const integrationService = createIntegrationService();
