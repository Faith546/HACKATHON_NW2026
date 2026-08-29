import { and, eq, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  carriers,
  mandates,
  negotiations,
  operations,
} from "../../db/schema";
import type * as databaseSchema from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type { EnqueueOutboundCallInput } from "../calls/calls.types";
import type {
  InboundCallResolution,
  VoiceCorePort,
  VoiceMandateSnapshot,
  VoiceToolContext,
  VoiceToolName,
} from "./voice-core.port";

type VoiceDatabase = BetterSQLite3Database<typeof databaseSchema>;
const closedOperationStatuses = ["CANCELLED", "COMPLETED"];

export class DrizzleVoiceCoreAdapter implements VoiceCorePort {
  constructor(private readonly database: VoiceDatabase) {}

  async resolveOutboundCallContext(
    input: EnqueueOutboundCallInput,
  ): Promise<{ toNumber: string }> {
    const operation = this.database
      .select({ id: operations.id, status: operations.status })
      .from(operations)
      .where(eq(operations.id, input.operationId))
      .get();
    if (!operation) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "La operación no existe.", {
        operationId: input.operationId,
      });
    }
    if (closedOperationStatuses.includes(operation.status)) {
      throw new ApiError(
        409,
        "OPERATION_NOT_CALLABLE",
        "La operación ya no admite llamadas salientes.",
        { operationId: input.operationId, status: operation.status },
      );
    }

    const carrier = this.database
      .select({ id: carriers.id, phone: carriers.phone, active: carriers.active })
      .from(carriers)
      .where(eq(carriers.id, input.carrierId))
      .get();
    if (!carrier) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "El carrier no existe.", {
        carrierId: input.carrierId,
      });
    }
    if (!carrier.active) {
      throw new ApiError(409, "CARRIER_INACTIVE", "El carrier está inactivo.", {
        carrierId: input.carrierId,
      });
    }
    if (carrier.phone.trim() === "") {
      throw new ApiError(
        422,
        "CARRIER_PHONE_MISSING",
        "El carrier no tiene teléfono.",
        { carrierId: input.carrierId },
      );
    }

    if (input.negotiationId) {
      const negotiation = this.database
        .select({ id: negotiations.id })
        .from(negotiations)
        .where(
          and(
            eq(negotiations.id, input.negotiationId),
            eq(negotiations.operationId, input.operationId),
            eq(negotiations.carrierId, input.carrierId),
          ),
        )
        .get();
      if (!negotiation) {
        throw new ApiError(
          422,
          "NEGOTIATION_CONTEXT_MISMATCH",
          "La negociación no pertenece a la operación y carrier indicados.",
          { negotiationId: input.negotiationId },
        );
      }
    }

    return { toNumber: carrier.phone };
  }

  async resolveInboundCallContext(input: {
    fromNumber: string;
    toNumber: string;
  }): Promise<InboundCallResolution> {
    const carrier = this.database
      .select({ id: carriers.id })
      .from(carriers)
      .where(and(eq(carriers.phone, input.fromNumber), eq(carriers.active, true)))
      .get();
    if (!carrier) {
      throw new ApiError(
        422,
        "INBOUND_CALLER_UNKNOWN",
        "No se encontró un carrier activo para el teléfono entrante.",
        { fromNumber: input.fromNumber },
      );
    }

    const negotiationCandidates = this.database
      .select({
        operationId: negotiations.operationId,
        negotiationId: negotiations.id,
      })
      .from(negotiations)
      .innerJoin(operations, eq(operations.id, negotiations.operationId))
      .where(
        and(
          eq(negotiations.carrierId, carrier.id),
          notInArray(operations.status, closedOperationStatuses),
        ),
      )
      .all();

    const byOperation = new Map<string, string | null>(
      negotiationCandidates.map((candidate) => [
        candidate.operationId,
        candidate.negotiationId,
      ]),
    );
    if (byOperation.size === 0) {
      const selectedOperations = this.database
        .select({ operationId: operations.id })
        .from(operations)
        .where(
          and(
            eq(operations.selectedCarrierId, carrier.id),
            notInArray(operations.status, closedOperationStatuses),
          ),
        )
        .all();
      for (const candidate of selectedOperations) {
        byOperation.set(candidate.operationId, null);
      }
    }

    if (byOperation.size === 0) {
      throw new ApiError(
        422,
        "INBOUND_CONTEXT_UNRESOLVED",
        "No hay una operación activa para el carrier entrante.",
        { carrierId: carrier.id },
      );
    }
    if (byOperation.size > 1) {
      throw new ApiError(
        409,
        "INBOUND_CONTEXT_AMBIGUOUS",
        "El carrier tiene varias operaciones activas.",
        { carrierId: carrier.id, operationIds: [...byOperation.keys()] },
      );
    }

    const [operationId, negotiationId] = [...byOperation.entries()][0];
    return {
      operationId,
      carrierId: carrier.id,
      negotiationId,
      purpose: negotiationId ? "RENEGOTIATION" : "INCIDENT",
    };
  }

  async getActiveMandate(
    operationId: string,
  ): Promise<VoiceMandateSnapshot | null> {
    return (
      this.database
        .select({
          id: mandates.id,
          operationId: mandates.operationId,
          version: mandates.version,
          maxTotalPriceCents: mandates.maxTotalPriceCents,
          currency: mandates.currency,
          pickupDate: mandates.pickupDate,
          notes: mandates.notes,
        })
        .from(mandates)
        .where(
          and(eq(mandates.operationId, operationId), eq(mandates.status, "ACTIVE")),
        )
        .get() ?? null
    );
  }

  async executeVoiceTool(_input: {
    name: VoiceToolName;
    context: VoiceToolContext;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    throw new ApiError(
      503,
      "VOICE_CORE_TOOL_UNAVAILABLE",
      "Parte A todavía no conectó el ejecutor determinista de tools.",
    );
  }
}
