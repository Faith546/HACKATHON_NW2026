import { ApiError } from "../../shared/http/api-error";
import {
  AuditRepository,
  auditRepository,
} from "./audit.repository";
import type {
  AuditEventResponse,
  AuditEventRow,
} from "./audit.types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(event: AuditEventRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.payloadJson);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Converted below to a stable API error rather than leaking SyntaxError.
  }
  throw new ApiError(
    500,
    "AUDIT_PAYLOAD_INVALID",
    `El payload del evento ${event.id} no contiene un objeto JSON válido.`,
  );
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async listAuditEvents(operationId: string): Promise<AuditEventResponse[]> {
    if (!this.repository.operationExists(operationId)) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Operación no encontrada.",
      );
    }

    return this.repository.listByOperation(operationId).map((event) => ({
      id: event.id,
      operationId: event.operationId,
      eventType: event.eventType,
      actorType: event.actorType as AuditEventResponse["actorType"],
      actorId: event.actorId,
      callId: event.callId,
      entityType: event.entityType,
      entityId: event.entityId,
      mandateId: event.mandateId,
      payload: parsePayload(event),
      occurredAt: event.occurredAt,
    }));
  }
}

export const auditService = new AuditService(auditRepository);
