import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "../../db";
import {
  auditEvents,
  calls,
  commitments,
  mandates,
  operations,
} from "../../db/schema";
import type * as databaseSchema from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  ConfirmExecutionEventInput,
  OperationExecutionResponse,
} from "./execution.types";

export type ExecutionDatabase = BetterSQLite3Database<typeof databaseSchema>;

export interface ExecutionRepositoryOptions {
  now?: () => Date;
  createAuditId?: () => string;
}

export class ExecutionRepository {
  private readonly now: () => Date;
  private readonly createAuditId: () => string;

  constructor(
    private readonly database: ExecutionDatabase = db,
    options: ExecutionRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createAuditId =
      options.createAuditId ?? (() => `evt_${randomUUID()}`);
  }

  confirmPickup(
    operationId: string,
    input: ConfirmExecutionEventInput,
    actorId?: string,
    actorType: "DRIVER" | "INTERNAL_OPERATOR" = "DRIVER",
  ): OperationExecutionResponse {
    return this.database.transaction((tx) => {
      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, operationId))
        .get();
      if (!operation) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "La operación no existe.",
          { operationId },
        );
      }
      if (operation.status !== "BOOKED" && operation.status !== "PICKUP_PENDING") {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          `La operación no puede confirmar pickup desde ${operation.status}.`,
          { operationId, status: operation.status },
        );
      }

      const call = executionCall(tx, operationId, input.callId, "EXECUTION");
      const commitment = tx
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.operationId, operationId),
            eq(commitments.status, "VALID"),
          ),
        )
        .limit(1)
        .get();
      if (!commitment) {
        throw new ApiError(
          409,
          "VALID_COMMITMENT_REQUIRED",
          "El pickup requiere un commitment en estado VALID.",
          { operationId },
        );
      }
      validateCarrierContext(operation, commitment, call);

      const mandate = activeMandate(tx, operationId);
      const updatedAt = this.now().toISOString();
      const updatedOperation = tx
        .update(operations)
        .set({ status: "IN_TRANSIT", updatedAt })
        .where(eq(operations.id, operation.id))
        .returning()
        .get();
      tx.update(commitments)
        .set({ status: "IN_EXECUTION", updatedAt })
        .where(eq(commitments.id, commitment.id))
        .run();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId,
          eventType: "PICKUP_CONFIRMED",
          actorType,
          actorId: actorId ?? input.confirmedBy,
          callId: call.id,
          entityType: "COMMITMENT",
          entityId: commitment.id,
          mandateId: commitment.mandateId,
          payloadJson: JSON.stringify({
            occurredAt: input.occurredAt,
            confirmedBy: input.confirmedBy,
            notes: input.notes ?? null,
            previousOperationStatus: operation.status,
            operationTransitions: ["PICKED_UP", "IN_TRANSIT"],
            previousCommitmentStatus: commitment.status,
            commitmentStatus: "IN_EXECUTION",
          }),
          occurredAt: input.occurredAt,
        })
        .run();

      return toOperationResponse(updatedOperation, mandate);
    });
  }

  confirmDelivery(
    operationId: string,
    input: ConfirmExecutionEventInput,
    actorId?: string,
    actorType: "DRIVER" | "INTERNAL_OPERATOR" = "DRIVER",
  ): OperationExecutionResponse {
    return this.database.transaction((tx) => {
      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, operationId))
        .get();
      if (!operation) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "La operación no existe.",
          { operationId },
        );
      }
      if (operation.status !== "IN_TRANSIT") {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          `La operación no puede confirmar delivery desde ${operation.status}.`,
          { operationId, status: operation.status },
        );
      }

      const call = executionCall(tx, operationId, input.callId, "DELIVERY");
      const commitment = tx
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.operationId, operationId),
            eq(commitments.status, "IN_EXECUTION"),
          ),
        )
        .limit(1)
        .get();
      if (!commitment) {
        throw new ApiError(
          409,
          "EXECUTING_COMMITMENT_REQUIRED",
          "El delivery requiere un commitment en estado IN_EXECUTION.",
          { operationId },
        );
      }
      validateCarrierContext(operation, commitment, call);

      const mandate = activeMandate(tx, operationId);
      const updatedAt = this.now().toISOString();
      const updatedOperation = tx
        .update(operations)
        .set({ status: "COMPLETED", updatedAt })
        .where(eq(operations.id, operation.id))
        .returning()
        .get();
      tx.update(commitments)
        .set({ status: "FULFILLED", updatedAt })
        .where(eq(commitments.id, commitment.id))
        .run();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId,
          eventType: "DELIVERY_CONFIRMED",
          actorType,
          actorId: actorId ?? input.confirmedBy,
          callId: call.id,
          entityType: "COMMITMENT",
          entityId: commitment.id,
          mandateId: commitment.mandateId,
          payloadJson: JSON.stringify({
            occurredAt: input.occurredAt,
            confirmedBy: input.confirmedBy,
            notes: input.notes ?? null,
            previousOperationStatus: operation.status,
            operationTransitions: ["DELIVERED", "COMPLETED"],
            previousCommitmentStatus: commitment.status,
            commitmentStatus: "FULFILLED",
          }),
          occurredAt: input.occurredAt,
        })
        .run();

      return toOperationResponse(updatedOperation, mandate);
    });
  }
}

type Transaction = Parameters<
  Parameters<ExecutionDatabase["transaction"]>[0]
>[0];

function executionCall(
  tx: Transaction,
  operationId: string,
  callId: string,
  expectedPurpose: "EXECUTION" | "DELIVERY",
): typeof calls.$inferSelect {
  const call = tx.select().from(calls).where(eq(calls.id, callId)).get();
  if (!call) {
    throw new ApiError(
      404,
      "RESOURCE_NOT_FOUND",
      "La llamada no existe.",
      { callId },
    );
  }
  if (call.operationId !== operationId) {
    throw new ApiError(
      409,
      "CALL_OPERATION_MISMATCH",
      "La llamada no pertenece a la operación indicada.",
      { callId, operationId },
    );
  }
  if (call.status !== "IN_PROGRESS" && call.status !== "COMPLETED") {
    throw new ApiError(
      409,
      "CALL_HAS_NO_EXECUTION_EVIDENCE",
      "La llamada aún no puede respaldar un evento de ejecución.",
      { callId, status: call.status },
    );
  }
  if (call.purpose !== expectedPurpose) {
    throw new ApiError(
      409,
      "CALL_PURPOSE_MISMATCH",
      `La evidencia requiere una llamada con propósito ${expectedPurpose}.`,
      { callId, purpose: call.purpose, expectedPurpose },
    );
  }
  return call;
}

function activeMandate(
  tx: Transaction,
  operationId: string,
): typeof mandates.$inferSelect {
  const mandate = tx
    .select()
    .from(mandates)
    .where(
      and(
        eq(mandates.operationId, operationId),
        eq(mandates.status, "ACTIVE"),
      ),
    )
    .orderBy(desc(mandates.version))
    .limit(1)
    .get();
  if (!mandate) {
    throw new ApiError(
      409,
      "ACTIVE_MANDATE_REQUIRED",
      "La operación no tiene un mandato activo.",
      { operationId },
    );
  }
  return mandate;
}

function validateCarrierContext(
  operation: typeof operations.$inferSelect,
  commitment: typeof commitments.$inferSelect,
  call: typeof calls.$inferSelect,
): void {
  if (operation.selectedCarrierId !== commitment.carrierId) {
    throw new ApiError(
      409,
      "COMMITMENT_CARRIER_MISMATCH",
      "El commitment válido no corresponde al carrier seleccionado.",
      {
        selectedCarrierId: operation.selectedCarrierId,
        commitmentCarrierId: commitment.carrierId,
      },
    );
  }
  if (call.carrierId && call.carrierId !== commitment.carrierId) {
    throw new ApiError(
      409,
      "CALL_CARRIER_MISMATCH",
      "La llamada pertenece a otro carrier.",
      { callCarrierId: call.carrierId, commitmentCarrierId: commitment.carrierId },
    );
  }
}

function toOperationResponse(
  operation: typeof operations.$inferSelect,
  mandate: typeof mandates.$inferSelect,
): OperationExecutionResponse {
  return {
    id: operation.id,
    customerName: operation.customerName,
    containerNumber: operation.containerNumber,
    origin: operation.origin,
    destination: operation.destination,
    service: operation.service,
    status: operation.status,
    selectedCarrierId: operation.selectedCarrierId,
    ...(operation.notes === null ? {} : { notes: operation.notes }),
    mandate: {
      id: mandate.id,
      operationId: mandate.operationId,
      version: mandate.version,
      status: mandate.status,
      maxTotalPrice: mandate.maxTotalPriceCents / 100,
      currency: mandate.currency,
      pickupDate: mandate.pickupDate,
      ...(mandate.notes === null ? {} : { notes: mandate.notes }),
      createdAt: mandate.createdAt,
    },
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}
