import type { commitments, operations } from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import { toCampaignResponse } from "../campaigns/campaigns.types";
import { campaignsService } from "../campaigns/campaigns.service";
import { carriersService } from "../carriers/carriers.service";
import { toMandateResponse } from "../mandates/mandates.types";
import { operationsRepository } from "./operations.repository";
import type {
  CancelOperationInput,
  CreateOperationInput,
  OperationResponse,
  OperationStatus,
} from "./operations.types";
import {
  containerNumberSchema,
  CreateOperationSchema,
} from "./operations.types";

type OperationRow = typeof operations.$inferSelect;
type CommitmentRow = typeof commitments.$inferSelect;

export function toOperationResponse(
  operation: OperationRow,
  mandate: Parameters<typeof toMandateResponse>[0] | null,
): OperationResponse {
  if (!mandate) {
    throw new ApiError(
      500,
      "OPERATION_MANDATE_INVARIANT_VIOLATION",
      "La operación no tiene un mandato activo.",
      { operationId: operation.id },
    );
  }
  return {
    id: operation.id,
    customerName: operation.customerName,
    containerNumber: operation.containerNumber,
    origin: operation.origin,
    destination: operation.destination,
    service: operation.service as "DRAYAGE",
    mandate: toMandateResponse(mandate),
    ...(operation.notes === null ? {} : { notes: operation.notes }),
    status: operation.status as OperationStatus,
    selectedCarrierId: operation.selectedCarrierId,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function toCommitmentResponse(commitment: CommitmentRow) {
  return {
    id: commitment.id,
    operationId: commitment.operationId,
    quoteId: commitment.quoteId,
    carrierId: commitment.carrierId,
    status: commitment.status,
    mandateId: commitment.mandateId,
    totalPrice: commitment.totalPriceCents / 100,
    currency: commitment.currency,
    pickupDate: commitment.pickupDate,
    verbalAgreementCallId: commitment.verbalAgreementCallId,
    evidenceStartMs: commitment.evidenceStartMs,
    evidenceEndMs: commitment.evidenceEndMs,
    evidenceTranscriptExcerpt: commitment.evidenceTranscriptExcerpt,
    summaryChannel: commitment.summaryChannel,
    summaryProviderId: commitment.summaryProviderId,
    summarySentAt: commitment.summarySentAt,
    createdAt: commitment.createdAt,
  };
}

export class OperationsService {
  async createOperation(
    input: CreateOperationInput,
    actorId?: string,
    carrierId?: string,
  ) {
    const parsedInput = CreateOperationSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Datos de operación inválidos.",
        parsedInput.error.format(),
      );
    }
    const validatedInput = parsedInput.data;
    if (carrierId) {
      const carrier = (await carriersService.listCarriers()).find(
        (candidate) => candidate.id === carrierId,
      );
      if (!carrier) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "El carrier no existe.", {
          carrierId,
        });
      }
      if (!carrier.active) {
        throw new ApiError(409, "CARRIER_INACTIVE", "El carrier está inactivo.", {
          carrierId,
        });
      }
    }

    const result = operationsRepository.createOperationWithMandate(
      validatedInput,
      actorId,
    );
    if (carrierId) {
      await campaignsService.startCampaign(
        result.operation.id,
        { carrierIds: [carrierId], maxParallelCalls: 1 },
        actorId,
      );
      return this.getOperation(result.operation.id);
    }
    return toOperationResponse(result.operation, result.mandate);
  }

  async listOperations(status?: OperationStatus) {
    return operationsRepository
      .findOperations(status)
      .map(({ operation, mandate }) =>
        toOperationResponse(operation, mandate),
      );
  }

  async getOperation(operationId: string) {
    const result = operationsRepository.findOperationById(operationId);
    if (!result) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Operación no encontrada.",
        { operationId },
      );
    }
    return toOperationResponse(result.operation, result.mandate);
  }

  async resolveOperationReference(input: {
    operationId?: string;
    containerNumber?: string;
  }) {
    const operationId = input.operationId?.trim();
    const rawContainerNumber = input.containerNumber?.trim();
    const parsedContainerNumber = rawContainerNumber
      ? containerNumberSchema.safeParse(rawContainerNumber)
      : null;
    if (parsedContainerNumber && !parsedContainerNumber.success) {
      throw new ApiError(
        422,
        "INVALID_CONTAINER_NUMBER",
        "El código del contenedor debe tener exactamente cuatro dígitos.",
        { containerNumber: rawContainerNumber },
      );
    }
    const containerNumber = parsedContainerNumber?.data;
    if (!operationId && !containerNumber) {
      throw new ApiError(
        422,
        "OPERATION_REFERENCE_REQUIRED",
        "Se requiere operationId o containerNumber para resolver la operación.",
      );
    }
    const byId = operationId
      ? operationsRepository.findOperationById(operationId)
      : null;
    const byContainer = containerNumber
      ? operationsRepository.findOperationByContainerNumber(containerNumber)
      : null;
    if (operationId && !byId) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operación no encontrada.", {
        operationId,
      });
    }
    if (containerNumber && !byContainer) {
      const possibleContainerNumbers =
        operationsRepository.findSimilarContainerNumbers(containerNumber);
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operación no encontrada.", {
        containerNumber,
        ...(possibleContainerNumbers.length > 0
          ? { possibleContainerNumbers }
          : {}),
      });
    }
    if (byId && byContainer && byId.operation.id !== byContainer.operation.id) {
      throw new ApiError(
        409,
        "OPERATION_REFERENCE_CONFLICT",
        "operationId y containerNumber corresponden a operaciones distintas.",
      );
    }
    const result = byId ?? byContainer;
    if (!result) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operación no encontrada.");
    }
    return toOperationResponse(result.operation, result.mandate);
  }

  async getOperationStatus(operationId: string) {
    const result = operationsRepository.getStatus(operationId);
    if (!result) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Operación no encontrada.",
        { operationId },
      );
    }
    return {
      operation: toOperationResponse(result.operation, result.mandate),
      activeMandate: result.mandate
        ? toMandateResponse(result.mandate)
        : null,
      activeCampaign:
        result.activeCampaign && result.campaignProgress
          ? toCampaignResponse(result.activeCampaign, result.campaignProgress)
          : null,
      activeCommitment: result.activeCommitment
        ? toCommitmentResponse(result.activeCommitment)
        : null,
      activeCalls: result.activeCalls,
      quoteCount: result.quoteCount,
    };
  }

  async cancelOperation(
    operationId: string,
    input: CancelOperationInput,
    actorId?: string,
  ) {
    const result = operationsRepository.cancelOperation(
      operationId,
      input,
      actorId,
    );
    return toOperationResponse(result.operation, result.mandate);
  }
}

export const operationsService = new OperationsService();
