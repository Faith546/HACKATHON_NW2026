import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const nowIso = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

export const carriers = sqliteTable(
  "carriers",
  {
    id: text("id").primaryKey().$defaultFn(() => id("car")),
    name: text("name").notNull(),
    dispatcherName: text("dispatcher_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    score: integer("score").notNull().default(80),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex("uq_carriers_phone").on(table.phone),
    check("ck_carriers_score", sql`${table.score} BETWEEN 0 AND 100`),
    check("ck_carriers_active", sql`${table.active} IN (0, 1)`),
  ],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey().$defaultFn(() => id("op")),
    customerName: text("customer_name").notNull(),
    containerNumber: text("container_number").notNull(),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    service: text("service").notNull().default("DRAYAGE"),
    status: text("status").notNull().default("CREATED"),
    selectedCarrierId: text("selected_carrier_id").references(
      () => carriers.id,
    ),
    weightKg: integer("weight_kg").notNull().default(10000),
    notes: text("notes"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    check("ck_operations_service", sql`${table.service} = 'DRAYAGE'`),
    check(
      "ck_operations_status",
      sql`${table.status} IN ('CREATED', 'SOURCING', 'BOOKED', 'PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'NEEDS_RENEGOTIATION', 'ESCALATED', 'NEEDS_CARRIER', 'CANCELLED')`,
    ),
    index("idx_operations_status").on(table.status),
    index("idx_operations_container").on(table.containerNumber),
  ],
);

export const mandates = sqliteTable(
  "mandates",
  {
    id: text("id").primaryKey().$defaultFn(() => id("man")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    maxTotalPriceCents: integer("max_total_price_cents").notNull(),
    currency: text("currency").notNull().default("MXN"),
    pickupDate: text("pickup_date").notNull(),
    notes: text("notes"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex("uq_mandates_operation_version").on(
      table.operationId,
      table.version,
    ),
    uniqueIndex("uq_mandates_one_active_per_operation")
      .on(table.operationId)
      .where(sql`${table.status} = 'ACTIVE'`),
    check("ck_mandates_version", sql`${table.version} > 0`),
    check(
      "ck_mandates_status",
      sql`${table.status} IN ('ACTIVE', 'SUPERSEDED')`,
    ),
    check(
      "ck_mandates_max_total_price",
      sql`${table.maxTotalPriceCents} > 0`,
    ),
    index("idx_mandates_operation").on(table.operationId),
  ],
);

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey().$defaultFn(() => id("cmp")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("QUEUED"),
    requestedCarriers: integer("requested_carriers").notNull(),
    maxParallelCalls: integer("max_parallel_calls").notNull().default(3),
    strategy: text("strategy").notNull().default("LOWEST_VALID_TOTAL"),
    winningQuoteId: text("winning_quote_id"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "ck_campaigns_status",
      sql`${table.status} IN ('QUEUED', 'CALLING', 'COLLECTING_QUOTES', 'READY_TO_SELECT', 'COMPLETED', 'FAILED')`,
    ),
    check(
      "ck_campaigns_requested_carriers",
      sql`${table.requestedCarriers} > 0`,
    ),
    check(
      "ck_campaigns_max_parallel_calls",
      sql`${table.maxParallelCalls} BETWEEN 1 AND 3`,
    ),
    check(
      "ck_campaigns_strategy",
      sql`${table.strategy} IN ('LOWEST_VALID_TOTAL', 'BALANCED_SCORE', 'BEST_WEIGHT_PRICE_RATIO')`,
    ),
    index("idx_campaigns_operation").on(
      table.operationId,
      table.createdAt,
    ),
  ],
);

export const negotiations = sqliteTable(
  "negotiations",
  {
    id: text("id").primaryKey().$defaultFn(() => id("neg")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriers.id),
    status: text("status").notNull().default("PENDING"),
    latestOfferJson: text("latest_offer_json"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex("uq_negotiations_campaign_carrier").on(
      table.campaignId,
      table.carrierId,
    ),
    check(
      "ck_negotiations_status",
      sql`${table.status} IN ('PENDING', 'CALLING', 'NEGOTIATING', 'QUOTED', 'REFUSED', 'NO_ANSWER', 'SELECTED', 'REJECTED')`,
    ),
    index("idx_negotiations_operation_status").on(
      table.operationId,
      table.status,
    ),
  ],
);

export const calls = sqliteTable(
  "calls",
  {
    id: text("id").primaryKey().$defaultFn(() => id("call")),
    operationId: text("operation_id").references(() => operations.id, {
      onDelete: "cascade",
    }),
    carrierId: text("carrier_id").references(() => carriers.id),
    negotiationId: text("negotiation_id").references(() => negotiations.id),
    actorType: text("actor_type").notNull().default("CARRIER"),
    twilioCallSid: text("twilio_call_sid"),
    twilioStreamSid: text("twilio_stream_sid"),
    recordingSid: text("recording_sid"),
    recordingStatus: text("recording_status"),
    recordingUrl: text("recording_url"),
    recordingDurationSeconds: integer("recording_duration_seconds"),
    realtimeSessionId: text("realtime_session_id"),
    direction: text("direction").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull().default("QUEUED"),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    transcriptText: text("transcript_text"),
    briefJson: text("brief_json"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex("uq_calls_twilio_call_sid").on(table.twilioCallSid),
    uniqueIndex("uq_calls_twilio_stream_sid").on(table.twilioStreamSid),
    uniqueIndex("uq_calls_recording_sid").on(table.recordingSid),
    check(
      "ck_calls_direction",
      sql`${table.direction} IN ('OUTBOUND', 'INBOUND')`,
    ),
    check(
      "ck_calls_actor_type",
      sql`${table.actorType} IN ('INTERNAL_OPERATOR', 'CARRIER', 'DISPATCHER', 'DRIVER')`,
    ),
    check(
      "ck_calls_purpose",
      sql`${table.purpose} IN ('OPERATIONS', 'QUOTE', 'COMMIT', 'EXECUTION', 'INCIDENT', 'DELIVERY', 'RENEGOTIATION', 'ESCALATION')`,
    ),
    check(
      "ck_calls_status",
      sql`${table.status} IN ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED')`,
    ),
    index("idx_calls_operation_created").on(
      table.operationId,
      table.createdAt,
    ),
    index("idx_calls_carrier_status").on(table.carrierId, table.status),
  ],
);

export const quotes = sqliteTable(
  "quotes",
  {
    id: text("id").primaryKey().$defaultFn(() => id("quo")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    negotiationId: text("negotiation_id")
      .notNull()
      .references(() => negotiations.id, { onDelete: "cascade" }),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriers.id),
    callId: text("call_id").references(() => calls.id),
    groundedCallerItemId: text("grounded_caller_item_id"),
    groundedTranscript: text("grounded_transcript"),
    groundedStartMs: integer("grounded_start_ms"),
    groundedEndMs: integer("grounded_end_ms"),
    totalPriceCents: integer("total_price_cents").notNull(),
    currency: text("currency").notNull().default("MXN"),
    pickupDate: text("pickup_date").notNull(),
    notes: text("notes"),
    dispatcherName: text("dispatcher_name"),
    valid: integer("valid", { mode: "boolean" }).notNull(),
    invalidReason: text("invalid_reason"),
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    validUntil: text("valid_until").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex("uq_quotes_negotiation_revision").on(
      table.negotiationId,
      table.revision,
    ),
    index("idx_quotes_negotiation").on(table.negotiationId),
    check("ck_quotes_total_price", sql`${table.totalPriceCents} > 0`),
    check("ck_quotes_valid", sql`${table.valid} IN (0, 1)`),
    index("idx_quotes_operation_valid_price").on(
      table.operationId,
      table.valid,
      table.totalPriceCents,
    ),
    index("idx_quotes_mandate").on(table.mandateId),
  ],
);

export const callTimingEvents = sqliteTable(
  "call_timing_events",
  {
    id: text("id").primaryKey().$defaultFn(() => id("tim")),
    callId: text("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    streamSid: text("stream_sid"),
    clock: text("clock").notNull(),
    eventType: text("event_type").notNull(),
    rawTimestampMs: integer("raw_timestamp_ms").notNull(),
    itemId: text("item_id"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    check(
      "ck_call_timing_clock",
      sql`${table.clock} IN ('twilio_stream', 'openai_input', 'recording', 'local_observation')`,
    ),
    index("idx_call_timing_call_created").on(table.callId, table.createdAt),
  ],
);

export const commitments = sqliteTable(
  "commitments",
  {
    id: text("id").primaryKey().$defaultFn(() => id("com")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriers.id),
    status: text("status").notNull().default("PROPOSED"),
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    totalPriceCents: integer("total_price_cents").notNull(),
    currency: text("currency").notNull().default("MXN"),
    pickupDate: text("pickup_date").notNull(),
    verbalAgreementCallId: text("verbal_agreement_call_id").references(
      () => calls.id,
    ),
    confirmedBy: text("confirmed_by"),
    exactTerms: text("exact_terms"),
    evidenceStartMs: integer("evidence_start_ms"),
    evidenceEndMs: integer("evidence_end_ms"),
    evidenceTranscriptExcerpt: text("evidence_transcript_excerpt"),
    summaryChannel: text("summary_channel"),
    summaryRecipient: text("summary_recipient"),
    summaryMessage: text("summary_message"),
    summaryProviderId: text("summary_provider_id"),
    summarySentAt: text("summary_sent_at"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex("uq_commitments_one_active_per_operation")
      .on(table.operationId)
      .where(
        sql`${table.status} IN ('PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED', 'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION')`,
      ),
    check(
      "ck_commitments_status",
      sql`${table.status} IN ('PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED', 'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION', 'FULFILLED', 'CANCELLED_BY_CARRIER', 'CANCELLED')`,
    ),
    check(
      "ck_commitments_total_price",
      sql`${table.totalPriceCents} > 0`,
    ),
    check(
      "ck_commitments_evidence_start",
      sql`${table.evidenceStartMs} IS NULL OR ${table.evidenceStartMs} >= 0`,
    ),
    check(
      "ck_commitments_evidence_end",
      sql`${table.evidenceEndMs} IS NULL OR ${table.evidenceEndMs} > 0`,
    ),
    check(
      "ck_commitments_evidence_range",
      sql`${table.evidenceStartMs} IS NULL OR ${table.evidenceEndMs} IS NULL OR ${table.evidenceStartMs} < ${table.evidenceEndMs}`,
    ),
    check(
      "ck_commitments_summary_channel",
      sql`${table.summaryChannel} IS NULL OR ${table.summaryChannel} IN ('SMS', 'EMAIL')`,
    ),
    index("idx_commitments_operation").on(table.operationId),
    index("idx_commitments_mandate").on(table.mandateId),
  ],
);

export const incidents = sqliteTable(
  "incidents",
  {
    id: text("id").primaryKey().$defaultFn(() => id("inc")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    callId: text("call_id").references(() => calls.id),
    type: text("type").notNull().default("GENERAL"),
    description: text("description").notNull(),
    reportedBy: text("reported_by"),
    status: text("status").notNull().default("OPEN"),
    proposedChangeJson: text("proposed_change_json"),
    evaluationCode: text("evaluation_code"),
    mandateId: text("mandate_id").references(() => mandates.id),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    check(
      "ck_incidents_status",
      sql`${table.status} IN ('OPEN', 'ALLOWED_CHANGE', 'NEEDS_ESCALATION', 'RESOLVED')`,
    ),
    index("idx_incidents_operation_status").on(
      table.operationId,
      table.status,
    ),
    index("idx_incidents_mandate").on(table.mandateId),
  ],
);

export const escalations = sqliteTable(
  "escalations",
  {
    id: text("id").primaryKey().$defaultFn(() => id("esc")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    callId: text("call_id")
      .notNull()
      .references(() => calls.id),
    incidentId: text("incident_id").references(() => incidents.id),
    reason: text("reason").notNull(),
    contextSummary: text("context_summary").notNull(),
    humanPhone: text("human_phone"),
    twilioConferenceSid: text("twilio_conference_sid"),
    humanParticipantCallSid: text("human_participant_call_sid"),
    previousOperationStatus: text("previous_operation_status")
      .notNull()
      .default("CREATED"),
    status: text("status").notNull().default("REQUESTED"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    check(
      "ck_escalations_status",
      sql`${table.status} IN ('REQUESTED', 'DIALING_HUMAN', 'HUMAN_JOINED', 'RESOLVED', 'FAILED')`,
    ),
    index("idx_escalations_operation").on(table.operationId),
    index("idx_escalations_status").on(table.status),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey().$defaultFn(() => id("evt")),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    callId: text("call_id").references(() => calls.id),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    mandateId: text("mandate_id").references(() => mandates.id),
    payloadJson: text("payload_json").notNull().default("{}"),
    occurredAt: text("occurred_at").notNull().$defaultFn(nowIso),
  },
  (table) => [
    check(
      "ck_audit_events_actor_type",
      sql`${table.actorType} IN ('SYSTEM', 'INTERNAL_OPERATOR', 'OPERATIONS_AGENT', 'LOGISTICS_AGENT', 'CARRIER', 'DRIVER')`,
    ),
    index("idx_audit_operation_time").on(
      table.operationId,
      table.occurredAt,
    ),
    index("idx_audit_events_mandate").on(table.mandateId),
  ],
);
