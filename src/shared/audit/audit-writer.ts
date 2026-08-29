import { randomUUID } from "node:crypto";

export type AuditActorType =
  | "SYSTEM"
  | "INTERNAL_OPERATOR"
  | "OPERATIONS_AGENT"
  | "LOGISTICS_AGENT"
  | "CARRIER"
  | "DRIVER";

export interface AuditEventInput {
  operationId: string;
  eventType: string;
  actorType: AuditActorType;
  actorId?: string | null;
  callId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  mandateId?: string | null;
  payload?: Record<string, unknown>;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface AuditEventRepository {
  insert(event: AuditEventRecord): Promise<void> | void;
}

export class AuditWriter {
  constructor(
    private readonly repository: AuditEventRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: AuditEventInput): Promise<AuditEventRecord> {
    const event: AuditEventRecord = {
      ...input,
      id: `evt_${randomUUID()}`,
      occurredAt: this.now().toISOString(),
      payload: input.payload ?? {},
    };

    await this.repository.insert(event);
    return event;
  }
}
