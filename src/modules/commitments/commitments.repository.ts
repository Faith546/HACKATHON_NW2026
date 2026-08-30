import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import {
  auditEvents,
  calls,
  campaigns,
  commitments,
  mandates,
  negotiations,
  operations,
  quotes,
} from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type {
  AttachEvidenceInput,
  AuthorizeCommitmentInput,
  CommitmentRecord,
  SendSummaryInput,
  VerbalAgreementInput,
} from "./commitments.types";

const activeCommitmentStatuses = [
  "PROPOSED",
  "VERBALLY_AGREED",
  "MANDATE_VALIDATED",
  "SUMMARY_PENDING",
  "SUMMARY_SENT",
  "VALID",
  "IN_EXECUTION",
] as const;

type AuditActorType =
  | "SYSTEM"
  | "INTERNAL_OPERATOR"
  | "LOGISTICS_AGENT";

interface AuditInput {
  operationId: string;
  mandateId: string;
  eventType: string;
  actorType: AuditActorType;
  actorId?: string;
  callId?: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

interface SummaryAcceptance {
  providerId: string;
  acceptedAt: string;
}

type CommitmentsTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("es-MX");
}

function isSqliteUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return String(error.code).startsWith("SQLITE_CONSTRAINT");
}

export class CommitmentsRepository {
  constructor(
    private readonly database: typeof db = db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private insertAudit(
    tx: CommitmentsTransaction,
    input: AuditInput,
    occurredAt: string,
  ): void {
    tx.insert(auditEvents)
      .values({
        id: `evt_${randomUUID()}`,
        operationId: input.operationId,
        mandateId: input.mandateId,
        eventType: input.eventType,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        callId: input.callId ?? null,
        entityType: "COMMITMENT",
        entityId: input.entityId,
        payloadJson: JSON.stringify(input.payload ?? {}),
        occurredAt,
      })
      .run();
  }

  async authorize(
    operationId: string,
    input: AuthorizeCommitmentInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    const occurredAt = this.now().toISOString();

    try {
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
            "Operación no encontrada.",
          );
        }
        if (operation.status !== "SOURCING") {
          throw new ApiError(
            409,
            "INVALID_STATE",
            `La operación debe estar SOURCING para autorizar el cierre; estado actual: ${operation.status}.`,
          );
        }

        const context = tx
          .select({
            quote: quotes,
            negotiation: negotiations,
            campaign: campaigns,
          })
          .from(quotes)
          .innerJoin(
            negotiations,
            eq(quotes.negotiationId, negotiations.id),
          )
          .innerJoin(campaigns, eq(negotiations.campaignId, campaigns.id))
          .where(eq(quotes.id, input.winningQuoteId))
          .get();
        if (!context) {
          throw new ApiError(
            404,
            "RESOURCE_NOT_FOUND",
            "Cotización ganadora no encontrada.",
          );
        }

        const { quote, negotiation, campaign } = context;
        if (
          quote.operationId !== operationId ||
          negotiation.operationId !== operationId ||
          campaign.operationId !== operationId
        ) {
          throw new ApiError(
            409,
            "QUOTE_OPERATION_MISMATCH",
            "La cotización ganadora no pertenece a la operación.",
          );
        }
        if (
          campaign.winningQuoteId !== quote.id ||
          campaign.status !== "COMPLETED"
        ) {
          throw new ApiError(
            409,
            "QUOTE_NOT_SELECTED_WINNER",
            "La cotización no es el ganador seleccionado de una campaña completada.",
          );
        }
        if (
          operation.selectedCarrierId !== quote.carrierId ||
          negotiation.carrierId !== quote.carrierId
        ) {
          throw new ApiError(
            409,
            "WINNER_CARRIER_MISMATCH",
            "El carrier seleccionado no coincide con la cotización ganadora.",
          );
        }
        if (!quote.valid) {
          throw new ApiError(
            409,
            "QUOTE_INVALID",
            "La cotización ganadora es inválida.",
          );
        }
        const validUntil = Date.parse(quote.validUntil);
        if (!Number.isFinite(validUntil) || validUntil <= this.now().getTime()) {
          throw new ApiError(
            409,
            "QUOTE_EXPIRED",
            "La cotización ganadora ya expiró.",
          );
        }

        const activeMandate = tx
          .select()
          .from(mandates)
          .where(
            and(
              eq(mandates.operationId, operationId),
              eq(mandates.status, "ACTIVE"),
            ),
          )
          .get();
        if (!activeMandate) {
          throw new ApiError(
            409,
            "ACTIVE_MANDATE_NOT_FOUND",
            "La operación no tiene un mandato activo.",
          );
        }
        if (quote.mandateId !== activeMandate.id) {
          throw new ApiError(
            409,
            "QUOTE_MANDATE_STALE",
            "La cotización fue evaluada contra un mandato que ya no está activo.",
          );
        }

        const existing = tx
          .select({ id: commitments.id })
          .from(commitments)
          .where(
            and(
              eq(commitments.operationId, operationId),
              inArray(commitments.status, [...activeCommitmentStatuses]),
            ),
          )
          .get();
        if (existing) {
          throw new ApiError(
            409,
            "ACTIVE_COMMITMENT_EXISTS",
            "Ya existe un commitment activo para esta operación.",
            { commitmentId: existing.id },
          );
        }

        const commitment = tx
          .insert(commitments)
          .values({
            operationId,
            quoteId: quote.id,
            carrierId: quote.carrierId,
            mandateId: quote.mandateId,
            totalPriceCents: quote.totalPriceCents,
            currency: quote.currency,
            pickupDate: quote.pickupDate,
            status: "PROPOSED",
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning()
          .get();

        tx.update(operations)
          .set({
            selectedCarrierId: quote.carrierId,
            updatedAt: occurredAt,
          })
          .where(eq(operations.id, operationId))
          .run();
        tx.update(negotiations)
          .set({ status: "SELECTED", updatedAt: occurredAt })
          .where(eq(negotiations.id, negotiation.id))
          .run();
        tx.update(negotiations)
          .set({ status: "REJECTED", updatedAt: occurredAt })
          .where(
            and(
              eq(negotiations.campaignId, campaign.id),
              ne(negotiations.id, negotiation.id),
              inArray(negotiations.status, [
                "PENDING",
                "CALLING",
                "NEGOTIATING",
                "QUOTED",
              ]),
            ),
          )
          .run();

        this.insertAudit(
          tx,
          {
            operationId,
            mandateId: activeMandate.id,
            eventType: "COMMIT_AUTHORIZED",
            actorType: "INTERNAL_OPERATOR",
            actorId,
            entityId: commitment.id,
            payload: {
              winningQuoteId: quote.id,
              carrierId: quote.carrierId,
              campaignId: campaign.id,
            },
          },
          occurredAt,
        );

        return commitment;
      }, { behavior: "immediate" });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isSqliteUniqueViolation(error)) {
        throw new ApiError(
          409,
          "ACTIVE_COMMITMENT_EXISTS",
          "Ya existe un commitment activo para esta operación.",
        );
      }
      throw error;
    }
  }

  async listByOperation(operationId: string): Promise<CommitmentRecord[]> {
    const operation = this.database
      .select({ id: operations.id })
      .from(operations)
      .where(eq(operations.id, operationId))
      .get();
    if (!operation) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Operación no encontrada.",
      );
    }
    return this.database
      .select()
      .from(commitments)
      .where(eq(commitments.operationId, operationId))
      .orderBy(asc(commitments.createdAt), asc(commitments.id))
      .all();
  }

  async getCommitment(commitmentId: string): Promise<CommitmentRecord | null> {
    return (
      this.database
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get() ?? null
    );
  }

  async findActiveByOperation(
    operationId: string,
  ): Promise<CommitmentRecord | null> {
    return (
      this.database
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.operationId, operationId),
            inArray(commitments.status, [...activeCommitmentStatuses]),
          ),
        )
        .get() ?? null
    );
  }

  async recordVerbalAgreement(
    commitmentId: string,
    input: VerbalAgreementInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    const occurredAt = this.now().toISOString();
    return this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Commitment no encontrado.",
        );
      }
      if (commitment.status !== "PROPOSED") {
        throw new ApiError(
          409,
          "INVALID_STATE",
          `El acuerdo verbal requiere estado PROPOSED; estado actual: ${commitment.status}.`,
        );
      }

      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, commitment.operationId))
        .get();
      if (
        !operation ||
        operation.status !== "SOURCING" ||
        operation.selectedCarrierId !== commitment.carrierId
      ) {
        throw new ApiError(
          409,
          "OPERATION_NOT_AUTHORIZED",
          "La operación ya no conserva la selección que autorizó el commitment.",
        );
      }

      const activeMandate = tx
        .select()
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, commitment.operationId),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .get();
      if (!activeMandate || activeMandate.id !== commitment.mandateId) {
        throw new ApiError(
          409,
          "COMMITMENT_MANDATE_STALE",
          "El mandato del commitment ya no es el mandato activo.",
        );
      }

      const quote = tx
        .select()
        .from(quotes)
        .where(eq(quotes.id, commitment.quoteId))
        .get();
      if (
        !quote ||
        !quote.valid ||
        quote.mandateId !== activeMandate.id ||
        quote.operationId !== commitment.operationId ||
        quote.carrierId !== commitment.carrierId ||
        quote.totalPriceCents !== commitment.totalPriceCents ||
        quote.currency !== commitment.currency ||
        quote.pickupDate !== commitment.pickupDate ||
        Date.parse(quote.validUntil) <= this.now().getTime()
      ) {
        throw new ApiError(
          409,
          "COMMITMENT_TERMS_NO_LONGER_VALID",
          "La cotización o los términos del commitment ya no son válidos.",
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
          "Llamada de confirmación no encontrada.",
        );
      }
      if (
        call.operationId !== commitment.operationId ||
        (call.carrierId !== null && call.carrierId !== commitment.carrierId)
      ) {
        throw new ApiError(
          409,
          "CALL_COMMITMENT_MISMATCH",
          "La llamada no pertenece a la operación y carrier del commitment.",
        );
      }
      if (
        call.purpose !== "COMMIT" ||
        !["IN_PROGRESS", "COMPLETED"].includes(call.status)
      ) {
        throw new ApiError(
          409,
          "CALL_NOT_CONFIRMABLE",
          "La llamada debe ser de tipo COMMIT y estar activa o completada.",
        );
      }

      tx.update(commitments)
        .set({
          status: "VERBALLY_AGREED",
          verbalAgreementCallId: call.id,
          confirmedBy: input.confirmedBy,
          exactTerms: input.exactTerms,
          updatedAt: occurredAt,
        })
        .where(eq(commitments.id, commitment.id))
        .run();
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: activeMandate.id,
          eventType: "VERBAL_AGREEMENT",
          actorType: "LOGISTICS_AGENT",
          actorId,
          callId: call.id,
          entityId: commitment.id,
          payload: {
            confirmedBy: input.confirmedBy,
            exactTerms: input.exactTerms,
          },
        },
        occurredAt,
      );

      const validated = tx
        .update(commitments)
        .set({ status: "MANDATE_VALIDATED", updatedAt: occurredAt })
        .where(eq(commitments.id, commitment.id))
        .returning()
        .get();
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: activeMandate.id,
          eventType: "COMMITMENT_MANDATE_VALIDATED",
          actorType: "SYSTEM",
          callId: call.id,
          entityId: commitment.id,
          payload: { mandateVersion: activeMandate.version },
        },
        occurredAt,
      );

      return validated;
    }, { behavior: "immediate" });
  }

  async attachEvidence(
    commitmentId: string,
    input: AttachEvidenceInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    const occurredAt = this.now().toISOString();
    return this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Commitment no encontrado.",
        );
      }
      if (commitment.status !== "MANDATE_VALIDATED") {
        throw new ApiError(
          409,
          "INVALID_STATE",
          `La evidencia requiere estado MANDATE_VALIDATED; estado actual: ${commitment.status}.`,
        );
      }
      if (commitment.evidenceStartMs !== null) {
        throw new ApiError(
          409,
          "EVIDENCE_ALREADY_ATTACHED",
          "El commitment ya tiene evidencia vinculada.",
        );
      }
      if (input.startMs >= input.endMs) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "startMs debe ser menor que endMs.",
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
          "Llamada de evidencia no encontrada.",
        );
      }
      if (
        call.operationId !== commitment.operationId ||
        call.id !== commitment.verbalAgreementCallId
      ) {
        throw new ApiError(
          409,
          "CALL_COMMITMENT_MISMATCH",
          "La evidencia debe pertenecer a la llamada del acuerdo verbal.",
        );
      }
      if (!call.transcriptText?.trim()) {
        throw new ApiError(
          409,
          "TRANSCRIPT_NOT_AVAILABLE",
          "La llamada todavía no tiene un transcript consolidado.",
        );
      }

      const normalizedTranscript = normalizeTranscript(call.transcriptText);
      const normalizedExcerpt = normalizeTranscript(input.transcriptExcerpt);
      if (!normalizedTranscript.includes(normalizedExcerpt)) {
        throw new ApiError(
          422,
          "TRANSCRIPT_EXCERPT_MISMATCH",
          "El fragmento indicado no aparece en el transcript de la llamada.",
        );
      }

      if (call.startedAt && call.endedAt) {
        const durationMs =
          Date.parse(call.endedAt) - Date.parse(call.startedAt);
        if (Number.isFinite(durationMs) && input.endMs > durationMs) {
          throw new ApiError(
            422,
            "EVIDENCE_RANGE_OUTSIDE_CALL",
            "El rango de evidencia excede la duración de la llamada.",
            { durationMs },
          );
        }
      }

      const updated = tx
        .update(commitments)
        .set({
          evidenceStartMs: input.startMs,
          evidenceEndMs: input.endMs,
          evidenceTranscriptExcerpt: input.transcriptExcerpt,
          updatedAt: occurredAt,
        })
        .where(eq(commitments.id, commitment.id))
        .returning()
        .get();
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: commitment.mandateId,
          eventType: "COMMITMENT_EVIDENCE_ATTACHED",
          actorType: "LOGISTICS_AGENT",
          actorId,
          callId: call.id,
          entityId: commitment.id,
          payload: {
            startMs: input.startMs,
            endMs: input.endMs,
            transcriptExcerpt: input.transcriptExcerpt,
          },
        },
        occurredAt,
      );
      return updated;
    }, { behavior: "immediate" });
  }

  async markSummaryPending(
    commitmentId: string,
    input: SendSummaryInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    const occurredAt = this.now().toISOString();
    return this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Commitment no encontrado.",
        );
      }
      if (commitment.status === "VALID" || commitment.status === "SUMMARY_SENT") {
        return commitment;
      }
      if (commitment.status === "SUMMARY_PENDING") {
        if (
          commitment.summaryChannel !== input.channel ||
          commitment.summaryRecipient !== input.recipient ||
          commitment.summaryMessage !== input.message
        ) {
          throw new ApiError(
            409,
            "SUMMARY_RETRY_MISMATCH",
            "Un retry debe conservar el mismo canal, destinatario y mensaje.",
          );
        }
        this.insertAudit(
          tx,
          {
            operationId: commitment.operationId,
            mandateId: commitment.mandateId,
            eventType: "SUMMARY_RETRY_QUEUED",
            actorType: "LOGISTICS_AGENT",
            actorId,
            callId: commitment.verbalAgreementCallId ?? undefined,
            entityId: commitment.id,
            payload: { channel: input.channel, recipient: input.recipient },
          },
          occurredAt,
        );
        return commitment;
      }
      if (commitment.status !== "MANDATE_VALIDATED") {
        throw new ApiError(
          409,
          "INVALID_STATE",
          `El recap requiere estado MANDATE_VALIDATED; estado actual: ${commitment.status}.`,
        );
      }
      if (
        commitment.evidenceStartMs === null ||
        commitment.evidenceEndMs === null ||
        !commitment.evidenceTranscriptExcerpt
      ) {
        throw new ApiError(
          409,
          "COMMITMENT_EVIDENCE_REQUIRED",
          "Debe adjuntarse evidencia válida antes de enviar el recap.",
        );
      }

      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, commitment.operationId))
        .get();
      if (
        !operation ||
        operation.status !== "SOURCING" ||
        operation.selectedCarrierId !== commitment.carrierId
      ) {
        throw new ApiError(
          409,
          "OPERATION_NOT_AUTHORIZED",
          "La operación ya no conserva la selección que autorizó el commitment.",
        );
      }

      const activeMandate = tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, commitment.operationId),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .get();
      if (!activeMandate || activeMandate.id !== commitment.mandateId) {
        throw new ApiError(
          409,
          "COMMITMENT_MANDATE_STALE",
          "El mandato del commitment ya no es el mandato activo.",
        );
      }

      const pending = tx
        .update(commitments)
        .set({
          status: "SUMMARY_PENDING",
          summaryChannel: input.channel,
          summaryRecipient: input.recipient,
          summaryMessage: input.message,
          summaryProviderId: null,
          summarySentAt: null,
          updatedAt: occurredAt,
        })
        .where(eq(commitments.id, commitment.id))
        .returning()
        .get();
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: commitment.mandateId,
          eventType: "SUMMARY_QUEUED",
          actorType: "LOGISTICS_AGENT",
          actorId,
          callId: commitment.verbalAgreementCallId ?? undefined,
          entityId: commitment.id,
          payload: {
            channel: input.channel,
            recipient: input.recipient,
          },
        },
        occurredAt,
      );
      return pending;
    }, { behavior: "immediate" });
  }

  async validateSummaryDispatch(
    commitmentId: string,
  ): Promise<CommitmentRecord> {
    return this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Commitment no encontrado.",
        );
      }
      if (commitment.status !== "SUMMARY_PENDING") {
        throw new ApiError(
          409,
          "INVALID_STATE",
          `No hay un recap pendiente para el commitment; estado actual: ${commitment.status}.`,
        );
      }

      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, commitment.operationId))
        .get();
      const activeMandate = tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, commitment.operationId),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .get();
      if (
        !operation ||
        operation.status !== "SOURCING" ||
        operation.selectedCarrierId !== commitment.carrierId ||
        activeMandate?.id !== commitment.mandateId
      ) {
        throw new ApiError(
          409,
          "SUMMARY_CONTEXT_STALE",
          "La operación, el carrier o el mandato cambiaron antes de enviar el recap.",
        );
      }
      return commitment;
    });
  }

  async markSummaryExhausted(
    commitmentId: string,
    error: unknown,
  ): Promise<void> {
    const occurredAt = this.now().toISOString();
    await this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment || commitment.status !== "SUMMARY_PENDING") return;
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: commitment.mandateId,
          eventType: "SUMMARY_SEND_EXHAUSTED",
          actorType: "SYSTEM",
          callId: commitment.verbalAgreementCallId ?? undefined,
          entityId: commitment.id,
          payload: {
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        },
        occurredAt,
      );
    }, { behavior: "immediate" });
  }

  async markSummarySent(
    commitmentId: string,
    acceptance: SummaryAcceptance,
  ): Promise<CommitmentRecord> {
    const occurredAt = acceptance.acceptedAt;
    if (
      !acceptance.providerId.trim() ||
      !Number.isFinite(Date.parse(acceptance.acceptedAt))
    ) {
      throw new ApiError(
        502,
        "SUMMARY_PROVIDER_INVALID_RESPONSE",
        "El proveedor no devolvió una aceptación válida.",
      );
    }

    return this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Commitment no encontrado.",
        );
      }
      if (commitment.status !== "SUMMARY_PENDING") {
        throw new ApiError(
          409,
          "INVALID_STATE",
          `La aceptación del recap requiere estado SUMMARY_PENDING; estado actual: ${commitment.status}.`,
        );
      }

      const sent = tx
        .update(commitments)
        .set({
          status: "SUMMARY_SENT",
          summaryProviderId: acceptance.providerId,
          summarySentAt: acceptance.acceptedAt,
          updatedAt: occurredAt,
        })
        .where(eq(commitments.id, commitment.id))
        .returning()
        .get();
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: commitment.mandateId,
          eventType: "SUMMARY_SENT",
          actorType: "SYSTEM",
          callId: commitment.verbalAgreementCallId ?? undefined,
          entityId: commitment.id,
          payload: {
            channel: commitment.summaryChannel,
            providerId: acceptance.providerId,
          },
        },
        occurredAt,
      );
      return sent;
    }, { behavior: "immediate" });
  }

  async markValid(commitmentId: string): Promise<CommitmentRecord> {
    const occurredAt = this.now().toISOString();
    return this.database.transaction((tx) => {
      const commitment = tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId))
        .get();
      if (!commitment) {
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Commitment no encontrado.",
        );
      }
      if (
        commitment.status !== "SUMMARY_SENT" ||
        !commitment.summaryProviderId ||
        !commitment.summarySentAt
      ) {
        throw new ApiError(
          409,
          "INVALID_STATE",
          "El commitment sólo puede validarse después de que el proveedor acepte el recap.",
        );
      }

      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.id, commitment.operationId))
        .get();
      const activeMandate = tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(
          and(
            eq(mandates.operationId, commitment.operationId),
            eq(mandates.status, "ACTIVE"),
          ),
        )
        .get();
      if (
        !operation ||
        operation.status !== "SOURCING" ||
        operation.selectedCarrierId !== commitment.carrierId ||
        activeMandate?.id !== commitment.mandateId
      ) {
        throw new ApiError(
          409,
          "SUMMARY_CONTEXT_STALE",
          "No se puede validar un commitment cuyo contexto operativo cambió.",
        );
      }

      const valid = tx
        .update(commitments)
        .set({ status: "VALID", updatedAt: occurredAt })
        .where(eq(commitments.id, commitment.id))
        .returning()
        .get();
      tx.update(operations)
        .set({ status: "BOOKED", updatedAt: occurredAt })
        .where(eq(operations.id, commitment.operationId))
        .run();
      this.insertAudit(
        tx,
        {
          operationId: commitment.operationId,
          mandateId: commitment.mandateId,
          eventType: "COMMITMENT_VALIDATED",
          actorType: "SYSTEM",
          callId: commitment.verbalAgreementCallId ?? undefined,
          entityId: commitment.id,
          payload: { summaryProviderId: commitment.summaryProviderId },
        },
        occurredAt,
      );
      return valid;
    }, { behavior: "immediate" });
  }

  // Compatibility facade methods used by IntegrationService.
  async createCommitment(
    operationId: string,
    input: AuthorizeCommitmentInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    return this.authorize(operationId, input, actorId);
  }

  async confirmCommitment(
    commitmentId: string,
    input: VerbalAgreementInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    return this.recordVerbalAgreement(commitmentId, input, actorId);
  }
}

export const commitmentsRepository = new CommitmentsRepository();
