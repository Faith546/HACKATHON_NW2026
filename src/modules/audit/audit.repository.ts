import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { auditEvents, operations } from "../../db/schema";
import { AuditWriter, type AuditEventRepository, type AuditEventRecord } from "../../shared/audit/audit-writer";
import type { AuditEventRow } from "./audit.types";

export class AuditRepository implements AuditEventRepository {
  constructor(private readonly database: typeof db = db) {}

  async insert(event: AuditEventRecord): Promise<void> {
    this.database
      .insert(auditEvents)
      .values({
        id: event.id,
        operationId: event.operationId,
        eventType: event.eventType,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        callId: event.callId ?? null,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        mandateId: event.mandateId ?? null,
        payloadJson: JSON.stringify(event.payload),
        occurredAt: event.occurredAt,
      })
      .run();
  }

  operationExists(operationId: string): boolean {
    return Boolean(
      this.database
        .select({ id: operations.id })
        .from(operations)
        .where(eq(operations.id, operationId))
        .get(),
    );
  }

  listByOperation(operationId: string): AuditEventRow[] {
    return this.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id))
      .all();
  }
}

export const auditRepository = new AuditRepository();
export const auditWriter = new AuditWriter(auditRepository);
