import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "../../db";
import {
  auditEvents,
  calls,
  escalations,
  incidents,
  operations,
} from "../../db/schema";
import type * as databaseSchema from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  JoinHumanConferenceInput,
  JoinHumanConferenceResult,
} from "./human-conference.gateway";
import type {
  JoinHumanInput,
  RequestEscalationInput,
} from "./escalations.types";

export type EscalationsDatabase = BetterSQLite3Database<
  typeof databaseSchema
>;
export type EscalationRecord = typeof escalations.$inferSelect;

export interface EscalationsRepositoryOptions {
  now?: () => Date;
  createEscalationId?: () => string;
  createAuditId?: () => string;
}

export interface BeginHumanJoinResult {
  escalation: EscalationRecord;
  gatewayInput: JoinHumanConferenceInput;
}

const activeEscalationStatuses = [
  "REQUESTED",
  "DIALING_HUMAN",
  "HUMAN_JOINED",
] as const;

export class EscalationsRepository {
  private readonly now: () => Date;
  private readonly createEscalationId: () => string;
  private readonly createAuditId: () => string;

  constructor(
    private readonly database: EscalationsDatabase = db,
    options: EscalationsRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createEscalationId =
      options.createEscalationId ?? (() => `esc_${randomUUID()}`);
    this.createAuditId =
      options.createAuditId ?? (() => `evt_${randomUUID()}`);
  }

  requestEscalation(
    operationId: string,
    input: RequestEscalationInput,
    actorId?: string,
  ): EscalationRecord {
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
      if (operation.status === "COMPLETED" || operation.status === "CANCELLED") {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "No se puede escalar una operación terminal.",
          { operationId, status: operation.status },
        );
      }

      const call = tx
        .select()
        .from(calls)
        .where(eq(calls.id, input.callId))
        .get();
      if (!call) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "La llamada no existe.",
          { callId: input.callId },
        );
      }
      if (call.operationId !== operationId) {
        throw new ApiError(
          409,
          "CALL_OPERATION_MISMATCH",
          "La llamada no pertenece a la operación indicada.",
          { callId: call.id, operationId },
        );
      }
      if (call.status !== "IN_PROGRESS") {
        throw new ApiError(
          409,
          "CALL_NOT_ACTIVE",
          "La escalación requiere una llamada activa.",
          { callId: call.id, status: call.status },
        );
      }
      if (!call.twilioCallSid) {
        throw new ApiError(
          409,
          "CALL_PROVIDER_ID_REQUIRED",
          "La llamada activa no tiene un CallSid para crear la conferencia.",
          { callId: call.id },
        );
      }

      let incident: typeof incidents.$inferSelect | null = null;
      if (input.incidentId) {
        incident = tx
          .select()
          .from(incidents)
          .where(eq(incidents.id, input.incidentId))
          .get() ?? null;
        if (!incident) {
          throw new ApiError(
            404,
            "RESOURCE_NOT_FOUND",
            "La incidencia no existe.",
            { incidentId: input.incidentId },
          );
        }
        if (incident.operationId !== operationId) {
          throw new ApiError(
            409,
            "INCIDENT_OPERATION_MISMATCH",
            "La incidencia no pertenece a la operación indicada.",
            { incidentId: incident.id, operationId },
          );
        }
        if (incident.status === "RESOLVED") {
          throw new ApiError(
            409,
            "INVALID_STATE_TRANSITION",
            "Una incidencia resuelta no puede originar una escalación activa.",
            { incidentId: incident.id, status: incident.status },
          );
        }
      }

      const duplicate = tx
        .select({ id: escalations.id })
        .from(escalations)
        .where(
          and(
            eq(escalations.callId, call.id),
            inArray(escalations.status, [...activeEscalationStatuses]),
          ),
        )
        .limit(1)
        .get();
      if (duplicate) {
        throw new ApiError(
          409,
          "ACTIVE_ESCALATION_EXISTS",
          "La llamada ya tiene una escalación activa.",
          { callId: call.id, escalationId: duplicate.id },
        );
      }

      const occurredAt = this.now().toISOString();
      const escalation = tx
        .insert(escalations)
        .values({
          id: this.createEscalationId(),
          operationId,
          callId: call.id,
          incidentId: incident?.id ?? null,
          reason: input.reason,
          contextSummary: input.contextSummary,
          humanPhone: input.requestedHumanPhone ?? null,
          status: "REQUESTED",
          createdAt: occurredAt,
        })
        .returning()
        .get();

      tx.update(operations)
        .set({ status: "ESCALATED", updatedAt: occurredAt })
        .where(eq(operations.id, operation.id))
        .run();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId,
          eventType: "ESCALATION_REQUESTED",
          actorType: "LOGISTICS_AGENT",
          actorId: actorId ?? null,
          callId: call.id,
          entityType: "ESCALATION",
          entityId: escalation.id,
          mandateId: incident?.mandateId ?? null,
          payloadJson: JSON.stringify({
            incidentId: escalation.incidentId,
            reason: escalation.reason,
            contextSummary: escalation.contextSummary,
            requestedHumanPhone: escalation.humanPhone,
            previousOperationStatus: operation.status,
          }),
          occurredAt,
        })
        .run();

      return escalation;
    });
  }

  beginHumanJoin(
    escalationId: string,
    input: JoinHumanInput,
    actorId?: string,
  ): BeginHumanJoinResult {
    return this.database.transaction((tx) => {
      const escalation = tx
        .select()
        .from(escalations)
        .where(eq(escalations.id, escalationId))
        .get();
      if (!escalation) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "La escalación no existe.",
          { escalationId },
        );
      }
      if (escalation.status !== "REQUESTED") {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          `No se puede incorporar al humano desde ${escalation.status}.`,
          { escalationId, status: escalation.status },
        );
      }

      const call = tx
        .select()
        .from(calls)
        .where(eq(calls.id, escalation.callId))
        .get();
      if (!call || call.operationId !== escalation.operationId) {
        throw new ApiError(
          409,
          "ESCALATION_CALL_MISMATCH",
          "La llamada de la escalación no tiene un contexto válido.",
          { escalationId, callId: escalation.callId },
        );
      }
      if (call.status !== "IN_PROGRESS") {
        throw new ApiError(
          409,
          "CALL_NOT_ACTIVE",
          "La llamada dejó de estar activa antes de incorporar al humano.",
          { callId: call.id, status: call.status },
        );
      }
      if (!call.twilioCallSid) {
        throw new ApiError(
          409,
          "CALL_PROVIDER_ID_REQUIRED",
          "La llamada activa no tiene un CallSid para crear la conferencia.",
          { callId: call.id },
        );
      }

      const occurredAt = this.now().toISOString();
      const updated = tx
        .update(escalations)
        .set({
          humanPhone: input.humanPhone,
          status: "DIALING_HUMAN",
        })
        .where(eq(escalations.id, escalation.id))
        .returning()
        .get();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId: escalation.operationId,
          eventType: "HUMAN_JOIN_QUEUED",
          actorType: "INTERNAL_OPERATOR",
          actorId: actorId ?? null,
          callId: call.id,
          entityType: "ESCALATION",
          entityId: escalation.id,
          payloadJson: JSON.stringify({ humanPhone: input.humanPhone }),
          occurredAt,
        })
        .run();

      return {
        escalation: updated,
        gatewayInput: {
          escalationId: escalation.id,
          operationId: escalation.operationId,
          callId: call.id,
          providerCallId: call.twilioCallSid,
          humanPhone: input.humanPhone,
        },
      };
    });
  }

  assertJoinStillActive(escalationId: string): void {
    const context = this.database
      .select({ escalation: escalations, call: calls })
      .from(escalations)
      .innerJoin(calls, eq(escalations.callId, calls.id))
      .where(eq(escalations.id, escalationId))
      .get();
    if (
      !context ||
      context.escalation.status !== "DIALING_HUMAN" ||
      context.call.status !== "IN_PROGRESS"
    ) {
      throw new ApiError(
        409,
        "CALL_NOT_ACTIVE",
        "La llamada dejó de estar disponible para la conferencia.",
        { escalationId },
      );
    }
  }

  markHumanJoined(
    escalationId: string,
    result: JoinHumanConferenceResult,
  ): EscalationRecord {
    return this.database.transaction((tx) => {
      const escalation = tx
        .select()
        .from(escalations)
        .where(eq(escalations.id, escalationId))
        .get();
      if (!escalation) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "La escalación no existe.");
      }
      if (escalation.status === "HUMAN_JOINED") return escalation;
      if (escalation.status !== "DIALING_HUMAN") {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "La escalación ya no está marcando al humano.",
          { escalationId, status: escalation.status },
        );
      }

      const occurredAt = this.now().toISOString();
      const updated = tx
        .update(escalations)
        .set({
          status: "HUMAN_JOINED",
          twilioConferenceSid: result.conferenceSid,
        })
        .where(eq(escalations.id, escalation.id))
        .returning()
        .get();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId: escalation.operationId,
          eventType: "HUMAN_JOINED",
          actorType: "SYSTEM",
          callId: escalation.callId,
          entityType: "ESCALATION",
          entityId: escalation.id,
          payloadJson: JSON.stringify({
            humanPhone: escalation.humanPhone,
            twilioConferenceSid: result.conferenceSid,
            humanParticipantCallSid: result.humanParticipantCallSid,
          }),
          occurredAt,
        })
        .run();

      return updated;
    });
  }

  markHumanJoinFailed(escalationId: string, error: unknown): void {
    this.database.transaction((tx) => {
      const escalation = tx
        .select()
        .from(escalations)
        .where(eq(escalations.id, escalationId))
        .get();
      if (!escalation || escalation.status !== "DIALING_HUMAN") return;

      const occurredAt = this.now().toISOString();
      tx.update(escalations)
        .set({ status: "FAILED", resolvedAt: occurredAt })
        .where(eq(escalations.id, escalation.id))
        .run();
      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId: escalation.operationId,
          eventType: "HUMAN_JOIN_FAILED",
          actorType: "SYSTEM",
          callId: escalation.callId,
          entityType: "ESCALATION",
          entityId: escalation.id,
          payloadJson: JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          }),
          occurredAt,
        })
        .run();
    });
  }

  findById(escalationId: string): EscalationRecord | null {
    return (
      this.database
        .select()
        .from(escalations)
        .where(eq(escalations.id, escalationId))
        .get() ?? null
    );
  }
}
