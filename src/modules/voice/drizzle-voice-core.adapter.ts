import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  carriers,
  commitments,
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
const inboundSelectedOperationStatuses = [
  "SOURCING",
  "BOOKED",
  "PICKUP_PENDING",
  "PICKED_UP",
  "IN_TRANSIT",
  "DELIVERED",
  "NEEDS_RENEGOTIATION",
  "ESCALATED",
];
export type VoiceToolExecutor = (input: {
  name: VoiceToolName;
  context: VoiceToolContext;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

export class DrizzleVoiceCoreAdapter implements VoiceCorePort {
  constructor(
    private readonly database: VoiceDatabase,
    private readonly toolExecutor?: VoiceToolExecutor,
  ) {}

  async resolveOutboundCallContext(
    input: EnqueueOutboundCallInput,
  ): Promise<{ toNumber: string }> {
    const operation = this.database
      .select({
        id: operations.id,
        status: operations.status,
        selectedCarrierId: operations.selectedCarrierId,
      })
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

    const negotiation = input.negotiationId
      ? this.database
        .select({ id: negotiations.id, status: negotiations.status })
        .from(negotiations)
        .where(
          and(
            eq(negotiations.id, input.negotiationId),
            eq(negotiations.operationId, input.operationId),
            eq(negotiations.carrierId, input.carrierId),
          ),
        )
        .get()
      : null;
    if (input.negotiationId) {
      if (!negotiation) {
        throw new ApiError(
          422,
          "NEGOTIATION_CONTEXT_MISMATCH",
          "La negociación no pertenece a la operación y carrier indicados.",
          { negotiationId: input.negotiationId },
        );
      }
    }

    if (
      (input.purpose === "QUOTE" || input.purpose === "RENEGOTIATION") &&
      !negotiation
    ) {
      throw new ApiError(
        422,
        "NEGOTIATION_CONTEXT_REQUIRED",
        `${input.purpose} requiere una negociación de la operación y carrier.`,
        { operationId: operation.id, carrierId: carrier.id },
      );
    }
    if (input.purpose === "QUOTE") {
      if (operation.status !== "SOURCING") {
        throw new ApiError(
          409,
          "OPERATION_NOT_SOURCING",
          "Las llamadas QUOTE sólo se permiten durante SOURCING.",
          { operationId: operation.id, status: operation.status },
        );
      }
      if (
        negotiation &&
        !["PENDING", "CALLING", "NEGOTIATING"].includes(
          negotiation.status,
        )
      ) {
        throw new ApiError(
          409,
          "NEGOTIATION_ALREADY_FINALIZED",
          "La negociación ya no admite una llamada de cotización.",
          { negotiationId: negotiation.id, status: negotiation.status },
        );
      }
    }
    if (input.purpose === "COMMIT") {
      if (operation.selectedCarrierId !== carrier.id) {
        throw new ApiError(
          409,
          "CARRIER_NOT_SELECTED",
          "La llamada COMMIT sólo puede dirigirse al carrier ganador.",
          { operationId: operation.id, carrierId: carrier.id },
        );
      }
      const authorizedCommitment = this.database
        .select({ id: commitments.id })
        .from(commitments)
        .where(
          and(
            eq(commitments.operationId, operation.id),
            eq(commitments.carrierId, carrier.id),
            inArray(commitments.status, [
              "PROPOSED",
              "VERBALLY_AGREED",
              "MANDATE_VALIDATED",
              "SUMMARY_PENDING",
              "SUMMARY_SENT",
            ]),
          ),
        )
        .limit(1)
        .get();
      if (!authorizedCommitment) {
        throw new ApiError(
          409,
          "AUTHORIZED_COMMITMENT_REQUIRED",
          "La llamada COMMIT requiere un commitment activo autorizado.",
          { operationId: operation.id, carrierId: carrier.id },
        );
      }
    }
    if (input.purpose === "FOLLOW_UP" || input.purpose === "ESCALATION") {
      if (operation.selectedCarrierId !== carrier.id) {
        throw new ApiError(
          409,
          "CARRIER_NOT_SELECTED",
          `La llamada ${input.purpose} requiere el carrier seleccionado.`,
          { operationId: operation.id, carrierId: carrier.id },
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
        operationStatus: operations.status,
        updatedAt: operations.updatedAt,
      })
      .from(negotiations)
      .innerJoin(operations, eq(operations.id, negotiations.operationId))
      .where(
        and(
          eq(negotiations.carrierId, carrier.id),
          inArray(operations.status, ["SOURCING", "NEEDS_RENEGOTIATION"]),
          or(
            inArray(negotiations.status, [
              "PENDING",
              "CALLING",
              "NEGOTIATING",
            ]),
            and(
              eq(negotiations.status, "SELECTED"),
              eq(operations.selectedCarrierId, carrier.id),
            ),
          ),
        ),
      )
      .all();

    const selectedOperations = this.database
      .select({
        operationId: operations.id,
        operationStatus: operations.status,
        updatedAt: operations.updatedAt,
      })
      .from(operations)
      .where(
        and(
          eq(operations.selectedCarrierId, carrier.id),
          inArray(operations.status, inboundSelectedOperationStatuses),
        ),
      )
      .all();
    const candidates = new Map<
      string,
      {
        operationId: string;
        negotiationId: string | null;
        operationStatus: string;
        updatedAt: string;
        selected: boolean;
      }
    >();
    for (const candidate of selectedOperations) {
      candidates.set(candidate.operationId, {
        ...candidate,
        negotiationId: null,
        selected: true,
      });
    }
    for (const candidate of negotiationCandidates) {
      const existing = candidates.get(candidate.operationId);
      if (!existing || candidate.updatedAt >= existing.updatedAt) {
        candidates.set(candidate.operationId, {
          ...candidate,
          selected: existing?.selected ?? false,
        });
      }
    }

    const selectedContext = [...candidates.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0];
    if (!selectedContext) {
      throw new ApiError(
        422,
        "INBOUND_CONTEXT_UNRESOLVED",
        "No hay una operación activa para el carrier entrante.",
        { carrierId: carrier.id },
      );
    }
    const {
      operationId,
      negotiationId,
      operationStatus,
      selected,
    } = selectedContext;
    return {
      operationId,
      carrierId: carrier.id,
      negotiationId,
      purpose:
        operationStatus === "SOURCING"
          ? selected
            ? "COMMIT"
            : "QUOTE"
          : operationStatus === "NEEDS_RENEGOTIATION"
            ? "RENEGOTIATION"
            : operationStatus === "IN_TRANSIT" ||
                operationStatus === "PICKED_UP" ||
                operationStatus === "DELIVERED"
              ? "DELIVERY"
              : operationStatus === "BOOKED" ||
                  operationStatus === "PICKUP_PENDING"
                ? "EXECUTION"
                : "ESCALATION",
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

  async executeVoiceTool(input: {
    name: VoiceToolName;
    context: VoiceToolContext;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    if (this.toolExecutor) return this.toolExecutor(input);
    throw new ApiError(
      503,
      "VOICE_CORE_TOOL_UNAVAILABLE",
      "Parte A todavía no conectó el ejecutor determinista de tools.",
    );
  }
}
