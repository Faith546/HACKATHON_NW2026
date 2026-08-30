import { db } from "../../db";
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
import type { ConfirmExecutionEventInput } from "../execution/execution.types";
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
    input: ConfirmExecutionEventInput,
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
        return this.operationsService.createOperation(
          args as CreateOperationInput,
          actorId,
        );
      case "createMandate":
        return this.mandatesService.createMandateVersion(
          input.context.operationId,
          args as Parameters<MandatesService["createMandateVersion"]>[1],
          actorId,
        );
      case "getOperationStatus":
        return this.operationsService.getOperationStatus(
          input.context.operationId,
        );
      case "listCarriers":
        return this.carriersService.listCarriers();
      case "startCampaign":
        return this.campaignsService.startCampaign(
          input.context.operationId,
          args as Parameters<CampaignsService["startCampaign"]>[1],
          actorId,
        );
      case "getQuotes":
        return this.marketService.listOperationQuotes(
          input.context.operationId,
        );
      case "getCommitments": {
        const commitments = await this.commitmentsService.listCommitments(
          input.context.operationId,
        );
        return commitments.map(toCommitmentResponse);
      }
      case "cancelOperation":
        return this.operationsService.cancelOperation(
          input.context.operationId,
          args as CancelOperationInput,
          actorId,
        );
      case "getActiveMandate":
        return this.getActiveMandate(input.context.operationId);
      case "evaluateOffer":
        return this.evaluateOffer(
          requireNegotiationId(input.context),
          args as EvaluateQuoteInput,
          actorId,
        );
      case "recordQuote":
        return this.recordQuote(
          requireNegotiationId(input.context),
          {
            ...(args as Omit<GroundedSaveQuoteInput, "callId" | "grounding">),
            callId: input.context.callId,
            grounding: input.context.quoteGrounding,
          },
          actorId,
        );
      case "reportNoAnswer":
        return this.campaignsService.reportNoAnswer(
          requireNegotiationId(input.context),
        );
      case "getAuthorizedCommitment": {
        const commitment = await this.getAuthorizedCommitment(
          input.context.operationId,
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
        return this.operationsService.getOperation(input.context.operationId);
      case "reportIncident":
        return this.incidentsService.reportIncident(
          input.context.operationId,
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
        this.assertIncidentContext(incidentId, input.context.operationId);
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
          input.context.operationId,
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
          input.context.operationId,
          {
            ...(args as Omit<ConfirmExecutionEventInput, "callId">),
            callId: input.context.callId,
          },
          actorId,
        );
      case "confirmDelivery":
        return this.confirmDelivery(
          input.context.operationId,
          {
            ...(args as Omit<ConfirmExecutionEventInput, "callId">),
            callId: input.context.callId,
          },
          actorId,
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
        }
        return brief;
      }
    }
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
    const commitment = await this.getAuthorizedCommitment(
      context.operationId,
    );
    if (!commitment) {
      throw new ApiError(
        409,
        "AUTHORIZED_COMMITMENT_REQUIRED",
        "La operación no tiene un commitment activo autorizado.",
        { operationId: context.operationId },
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
      }
    },
  };
}

export function createIntegrationService(
  dependencies: IntegrationServiceDependencies = {},
): IntegrationService {
  return new IntegrationService(dependencies);
}

export const integrationService = createIntegrationService();
