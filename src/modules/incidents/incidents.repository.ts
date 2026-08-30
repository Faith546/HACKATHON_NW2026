import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "../../db";
import {
  auditEvents,
  calls,
  incidents,
  mandates,
  operations,
} from "../../db/schema";
import type * as databaseSchema from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  EvaluateChangeInput,
  EvaluationCode,
  EvaluationResult,
  ReportIncidentInput,
} from "./incidents.types";

export type IncidentsDatabase = BetterSQLite3Database<typeof databaseSchema>;
export type IncidentRecord = typeof incidents.$inferSelect;

export interface IncidentsRepositoryOptions {
  now?: () => Date;
  createIncidentId?: () => string;
  createAuditId?: () => string;
}

export class IncidentsRepository {
  private readonly now: () => Date;
  private readonly createIncidentId: () => string;
  private readonly createAuditId: () => string;

  constructor(
    private readonly database: IncidentsDatabase = db,
    options: IncidentsRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createIncidentId =
      options.createIncidentId ?? (() => `inc_${randomUUID()}`);
    this.createAuditId =
      options.createAuditId ?? (() => `evt_${randomUUID()}`);
  }

  reportIncident(
    operationId: string,
    input: ReportIncidentInput,
    actorId?: string,
  ): IncidentRecord {
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
      if (call.operationId !== operation.id) {
        throw new ApiError(
          409,
          "CALL_OPERATION_MISMATCH",
          "La llamada no pertenece a la operación indicada.",
          { callId: call.id, operationId },
        );
      }

      const occurredAt = this.now().toISOString();
      const incident = tx
        .insert(incidents)
        .values({
          id: this.createIncidentId(),
          operationId,
          callId: call.id,
          type: input.type,
          description: input.description,
          reportedBy: input.reportedBy ?? null,
          status: "OPEN",
          createdAt: occurredAt,
        })
        .returning()
        .get();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId,
          eventType: "INCIDENT_REPORTED",
          actorType: "DRIVER",
          actorId: actorId ?? input.reportedBy ?? null,
          callId: call.id,
          entityType: "INCIDENT",
          entityId: incident.id,
          payloadJson: JSON.stringify({
            type: incident.type,
            description: incident.description,
            reportedBy: incident.reportedBy,
          }),
          occurredAt,
        })
        .run();

      return incident;
    });
  }

  evaluateChange(
    incidentId: string,
    input: EvaluateChangeInput,
    actorId?: string,
  ): EvaluationResult {
    return this.database.transaction((tx) => {
      const incident = tx
        .select()
        .from(incidents)
        .where(eq(incidents.id, incidentId))
        .get();
      if (!incident) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "La incidencia no existe.",
          { incidentId },
        );
      }
      if (incident.status === "RESOLVED") {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "Una incidencia resuelta ya no puede volver a evaluarse.",
          { incidentId, status: incident.status },
        );
      }

      const mandate = tx
        .select()
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, incident.operationId),
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
          "La operación no tiene un mandato activo contra el cual evaluar el cambio.",
          { operationId: incident.operationId },
        );
      }

      const proposedChange = {
        ...(input.proposedPickupDate === undefined
          ? {}
          : { proposedPickupDate: input.proposedPickupDate }),
        ...(input.proposedTotalPrice === undefined
          ? {}
          : { proposedTotalPrice: input.proposedTotalPrice }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      };
      const reasons: string[] = [];
      let code: EvaluationCode = "ALLOWED";

      if (input.proposedTotalPrice !== undefined) {
        const proposedTotalPriceCents = Math.round(
          input.proposedTotalPrice * 100,
        );
        if (proposedTotalPriceCents > mandate.maxTotalPriceCents) {
          code = "PRICE_EXCEEDS_MANDATE";
          reasons.push(
            `El precio total de ${input.proposedTotalPrice} ${mandate.currency} supera el máximo de ${mandate.maxTotalPriceCents / 100} ${mandate.currency}.`,
          );
        }
      }

      if (input.proposedPickupDate !== undefined) {
        const mandatedDate = toDateOnly(mandate.pickupDate);
        if (!mandatedDate) {
          throw new ApiError(
            422,
            "MANDATE_NOT_EVALUABLE",
            "La fecha del mandato activo no puede evaluarse.",
            { mandateId: mandate.id, pickupDate: mandate.pickupDate },
          );
        }
        if (input.proposedPickupDate !== mandatedDate) {
          if (code === "ALLOWED") code = "DATE_OUTSIDE_MANDATE";
          reasons.push(
            `La fecha de pickup ${input.proposedPickupDate} no coincide con la fecha autorizada ${mandatedDate}.`,
          );
        }
      }

      const allowed = code === "ALLOWED";
      if (allowed) {
        reasons.push("El cambio propuesto está dentro del mandato vigente.");
      }
      const nextStatus = allowed ? "ALLOWED_CHANGE" : "NEEDS_ESCALATION";
      const occurredAt = this.now().toISOString();

      tx.update(incidents)
        .set({
          status: nextStatus,
          proposedChangeJson: JSON.stringify(proposedChange),
          evaluationCode: code,
          mandateId: mandate.id,
        })
        .where(eq(incidents.id, incident.id))
        .run();

      tx.insert(auditEvents)
        .values({
          id: this.createAuditId(),
          operationId: incident.operationId,
          eventType: "INCIDENT_CHANGE_EVALUATED",
          actorType: "LOGISTICS_AGENT",
          actorId: actorId ?? null,
          callId: incident.callId,
          entityType: "INCIDENT",
          entityId: incident.id,
          mandateId: mandate.id,
          payloadJson: JSON.stringify({
            proposedChange,
            allowed,
            code,
            reasons,
          }),
          occurredAt,
        })
        .run();

      return { allowed, code, mandateId: mandate.id, reasons };
    });
  }

  findById(incidentId: string): IncidentRecord | null {
    return (
      this.database
        .select()
        .from(incidents)
        .where(eq(incidents.id, incidentId))
        .get() ?? null
    );
  }
}

function toDateOnly(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== match[1]
  ) {
    return null;
  }
  return match[1];
}
