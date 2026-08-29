import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";

// --- Entities ---

export const carriers = sqliteTable("carriers", {
  id: text("id").primaryKey().$defaultFn(() => `car_${randomUUID()}`),
  name: text("name").notNull(),
  dispatcherName: text("dispatcher_name").notNull(),
  phone: text("phone").notNull().unique(),
  email: text("email"),
  score: integer("score").notNull().default(80),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const operations = sqliteTable("operations", {
  id: text("id").primaryKey().$defaultFn(() => `op_${randomUUID()}`),
  customerName: text("customer_name").notNull(),
  containerNumber: text("container_number").notNull(),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  service: text("service").notNull().default("DRAYAGE"),
  status: text("status").notNull(), 
  selectedCarrierId: text("selected_carrier_id").references(() => carriers.id),
  notes: text("notes"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const mandates = sqliteTable("mandates", {
  id: text("id").primaryKey().$defaultFn(() => `man_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull(), // ACTIVE, SUPERSEDED
  maxTotalPriceCents: integer("max_total_price_cents").notNull(),
  currency: text("currency").notNull().default("MXN"),
  pickupDate: text("pickup_date").notNull(),
  pickupStart: text("pickup_start").notNull(),
  pickupEnd: text("pickup_end").notNull(),
  timezone: text("timezone").notNull().default("America/Mexico_City"),
  additionalChargesAllowed: integer("additional_charges_allowed").notNull().default(0),
  maxDelayMinutes: integer("max_delay_minutes").notNull().default(120),
  dateChangeAllowed: integer("date_change_allowed").notNull().default(0),
  routeChangeAllowed: integer("route_change_allowed").notNull().default(0),
  conditionsJson: text("conditions_json").notNull().default("{}"),
  changeReason: text("change_reason"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey().$defaultFn(() => `cmp_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  status: text("status").notNull(), 
  requestedCarriers: integer("requested_carriers").notNull(),
  maxParallelCalls: integer("max_parallel_calls").notNull().default(3),
  strategy: text("strategy").notNull().default("LOWEST_VALID_TOTAL"),
  winningQuoteId: text("winning_quote_id"), // Not a strict FK to avoid circular creation
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
});

export const negotiations = sqliteTable("negotiations", {
  id: text("id").primaryKey().$defaultFn(() => `neg_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  carrierId: text("carrier_id").notNull().references(() => carriers.id),
  status: text("status").notNull(),
  latestOfferJson: text("latest_offer_json"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const calls = sqliteTable("calls", {
  id: text("id").primaryKey().$defaultFn(() => `call_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  carrierId: text("carrier_id").references(() => carriers.id),
  negotiationId: text("negotiation_id").references(() => negotiations.id),
  twilioCallSid: text("twilio_call_sid").unique(),
  realtimeSessionId: text("realtime_session_id"),
  direction: text("direction").notNull(), // INBOUND, OUTBOUND
  purpose: text("purpose").notNull(),
  status: text("status").notNull(),
  fromNumber: text("from_number"),
  toNumber: text("to_number"),
  recordingSid: text("recording_sid").unique(),
  recordingUrl: text("recording_url"),
  recordingDurationSeconds: integer("recording_duration_seconds"),
  transcriptText: text("transcript_text"),
  briefJson: text("brief_json"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const quotes = sqliteTable("quotes", {
  id: text("id").primaryKey().$defaultFn(() => `quo_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  negotiationId: text("negotiation_id").notNull().references(() => negotiations.id, { onDelete: "cascade" }),
  carrierId: text("carrier_id").notNull().references(() => carriers.id),
  callId: text("call_id").references(() => calls.id),
  basePriceCents: integer("base_price_cents").notNull(),
  additionalChargesCents: integer("additional_charges_cents").notNull().default(0),
  totalPriceCents: integer("total_price_cents").notNull(),
  currency: text("currency").notNull().default("MXN"),
  pickupDate: text("pickup_date").notNull(),
  pickupTime: text("pickup_time").notNull(),
  conditionsJson: text("conditions_json").notNull().default("[]"),
  valid: integer("valid").notNull(),
  invalidReason: text("invalid_reason"),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  validUntil: text("valid_until").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const commitments = sqliteTable("commitments", {
  id: text("id").primaryKey().$defaultFn(() => `com_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  quoteId: text("quote_id").notNull().references(() => quotes.id),
  carrierId: text("carrier_id").notNull().references(() => carriers.id),
  status: text("status").notNull(),
  mandateId: text("mandate_id").notNull().references(() => mandates.id),
  totalPriceCents: integer("total_price_cents").notNull(),
  currency: text("currency").notNull().default("MXN"),
  pickupAt: text("pickup_at").notNull(),
  verbalAgreementCallId: text("verbal_agreement_call_id").references(() => calls.id),
  confirmedBy: text("confirmed_by"),
  exactTerms: text("exact_terms"),
  recordingUrl: text("recording_url"),
  evidenceStartMs: integer("evidence_start_ms"),
  evidenceEndMs: integer("evidence_end_ms"),
  summaryChannel: text("summary_channel"),
  summaryRecipient: text("summary_recipient"),
  summaryMessage: text("summary_message"),
  summaryProviderId: text("summary_provider_id"),
  summarySentAt: text("summary_sent_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey().$defaultFn(() => `inc_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  callId: text("call_id").references(() => calls.id),
  type: text("type").notNull(),
  description: text("description").notNull(),
  reportedBy: text("reported_by"),
  status: text("status").notNull(),
  proposedChangeJson: text("proposed_change_json"),
  evaluationCode: text("evaluation_code"),
  mandateId: text("mandate_id").references(() => mandates.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  resolvedAt: text("resolved_at"),
});

export const escalations = sqliteTable("escalations", {
  id: text("id").primaryKey().$defaultFn(() => `esc_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  callId: text("call_id").notNull().references(() => calls.id),
  incidentId: text("incident_id").references(() => incidents.id),
  reason: text("reason").notNull(),
  contextSummary: text("context_summary").notNull(),
  humanPhone: text("human_phone"),
  twilioConferenceSid: text("twilio_conference_sid"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  resolvedAt: text("resolved_at"),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey().$defaultFn(() => `aud_${randomUUID()}`),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  callId: text("call_id").references(() => calls.id),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  mandateId: text("mandate_id").references(() => mandates.id),
  payloadJson: text("payload_json").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull().$defaultFn(() => new Date().toISOString()),
});
