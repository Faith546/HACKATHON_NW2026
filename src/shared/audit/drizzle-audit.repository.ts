import { auditEvents } from "../../db/schema";
import type { AuditEventRepository, AuditEventRecord } from "./audit-writer";

// Since Persona B might want to pass a transaction, we accept a drizzle db instance or a transaction instance
export class DrizzleAuditRepository implements AuditEventRepository {
  constructor(private readonly dbOrTx: any) {}

  async insert(event: AuditEventRecord): Promise<void> {
    await this.dbOrTx.insert(auditEvents).values({
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
    });
  }
}
