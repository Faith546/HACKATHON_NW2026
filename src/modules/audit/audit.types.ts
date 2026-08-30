import type { auditEvents } from "../../db/schema";
import type { AuditActorType } from "../../shared/audit/audit-writer";

export type AuditEventRow = typeof auditEvents.$inferSelect;

export interface AuditEventResponse {
  id: string;
  operationId: string;
  eventType: string;
  actorType: AuditActorType;
  actorId: string | null;
  callId: string | null;
  entityType: string | null;
  entityId: string | null;
  mandateId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}
