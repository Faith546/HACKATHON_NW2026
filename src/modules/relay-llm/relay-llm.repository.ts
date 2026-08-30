import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  calls,
  campaigns,
  carriers,
  commitments,
  escalations,
  incidents,
  mandates,
  operations,
  quotes,
} from "../../db/schema";
import type { RelayOperationalContextRepository } from "./relay-llm.types";

const MAX_CONTEXT_ITEMS = 30;

export class DrizzleRelayOperationalContextRepository
  implements RelayOperationalContextRepository
{
  async getContext(operationId?: string): Promise<string> {
    const operationRows = db
      .select({
        id: operations.id,
        customerName: operations.customerName,
        containerNumber: operations.containerNumber,
        origin: operations.origin,
        destination: operations.destination,
        service: operations.service,
        status: operations.status,
        weightKg: operations.weightKg,
        notes: operations.notes,
        selectedCarrierName: carriers.name,
        updatedAt: operations.updatedAt,
      })
      .from(operations)
      .leftJoin(carriers, eq(operations.selectedCarrierId, carriers.id))
      .where(operationId ? eq(operations.id, operationId) : undefined)
      .orderBy(desc(operations.updatedAt))
      .limit(MAX_CONTEXT_ITEMS)
      .all();

    const operationIds = operationRows.map((operation) => operation.id);
    if (operationIds.length === 0) {
      return JSON.stringify({
        generatedAt: new Date().toISOString(),
        operations: [],
        note: operationId
          ? "No existe una operación con el identificador indicado."
          : "No hay operaciones registradas.",
      });
    }

    const carrierRows = db
      .select({ id: carriers.id, name: carriers.name, score: carriers.score, active: carriers.active })
      .from(carriers)
      .where(operationId ? undefined : eq(carriers.active, true))
      .orderBy(desc(carriers.score))
      .limit(MAX_CONTEXT_ITEMS)
      .all();

    const [mandateRows, campaignRows, quoteRows, commitmentRows, incidentRows, escalationRows, callRows] = [
      db.select({ operationId: mandates.operationId, version: mandates.version, status: mandates.status, maxTotalPrice: mandates.maxTotalPriceCents, currency: mandates.currency, pickupDate: mandates.pickupDate, notes: mandates.notes })
        .from(mandates).where(inArray(mandates.operationId, operationIds)).orderBy(desc(mandates.version)).limit(MAX_CONTEXT_ITEMS).all(),
      db.select({ operationId: campaigns.operationId, status: campaigns.status, requestedCarriers: campaigns.requestedCarriers, strategy: campaigns.strategy, createdAt: campaigns.createdAt, completedAt: campaigns.completedAt })
        .from(campaigns).where(inArray(campaigns.operationId, operationIds)).orderBy(desc(campaigns.createdAt)).limit(MAX_CONTEXT_ITEMS).all(),
      db.select({ operationId: quotes.operationId, carrierName: carriers.name, totalPrice: quotes.totalPriceCents, currency: quotes.currency, pickupDate: quotes.pickupDate, valid: quotes.valid, invalidReason: quotes.invalidReason, validUntil: quotes.validUntil, notes: quotes.notes })
        .from(quotes).innerJoin(carriers, eq(quotes.carrierId, carriers.id)).where(inArray(quotes.operationId, operationIds)).orderBy(desc(quotes.createdAt)).limit(MAX_CONTEXT_ITEMS).all(),
      db.select({ operationId: commitments.operationId, carrierName: carriers.name, status: commitments.status, totalPrice: commitments.totalPriceCents, currency: commitments.currency, pickupDate: commitments.pickupDate, createdAt: commitments.createdAt, updatedAt: commitments.updatedAt })
        .from(commitments).innerJoin(carriers, eq(commitments.carrierId, carriers.id)).where(inArray(commitments.operationId, operationIds)).orderBy(desc(commitments.updatedAt)).limit(MAX_CONTEXT_ITEMS).all(),
      db.select({ operationId: incidents.operationId, type: incidents.type, description: incidents.description, status: incidents.status, createdAt: incidents.createdAt, resolvedAt: incidents.resolvedAt })
        .from(incidents).where(inArray(incidents.operationId, operationIds)).orderBy(desc(incidents.createdAt)).limit(MAX_CONTEXT_ITEMS).all(),
      db.select({ operationId: escalations.operationId, reason: escalations.reason, contextSummary: escalations.contextSummary, status: escalations.status, createdAt: escalations.createdAt, resolvedAt: escalations.resolvedAt })
        .from(escalations).where(inArray(escalations.operationId, operationIds)).orderBy(desc(escalations.createdAt)).limit(MAX_CONTEXT_ITEMS).all(),
      db.select({ operationId: calls.operationId, carrierName: carriers.name, direction: calls.direction, purpose: calls.purpose, status: calls.status, startedAt: calls.startedAt, endedAt: calls.endedAt, createdAt: calls.createdAt })
        .from(calls).leftJoin(carriers, eq(calls.carrierId, carriers.id)).where(inArray(calls.operationId, operationIds)).orderBy(desc(calls.createdAt)).limit(MAX_CONTEXT_ITEMS).all(),
    ];

    return JSON.stringify({
      generatedAt: new Date().toISOString(),
      moneyUnit: "Los importes están expresados en unidades menores (centavos).",
      operations: operationRows,
      mandates: mandateRows,
      carriers: carrierRows,
      campaigns: campaignRows,
      quotes: quoteRows,
      commitments: commitmentRows,
      incidents: incidentRows,
      emergencies: escalationRows,
      calls: callRows,
    });
  }
}

export const relayOperationalContextRepository =
  new DrizzleRelayOperationalContextRepository();
