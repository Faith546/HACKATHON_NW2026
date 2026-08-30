CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`call_id` text,
	`entity_type` text,
	`entity_id` text,
	`mandate_id` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_audit_events_actor_type" CHECK("audit_events"."actor_type" IN ('SYSTEM', 'INTERNAL_OPERATOR', 'OPERATIONS_AGENT', 'LOGISTICS_AGENT', 'CARRIER', 'DRIVER'))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_operation_time` ON `audit_events` (`operation_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_mandate` ON `audit_events` (`mandate_id`);--> statement-breakpoint
CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`carrier_id` text,
	`negotiation_id` text,
	`twilio_call_sid` text,
	`realtime_session_id` text,
	`direction` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`from_number` text,
	`to_number` text,
	`transcript_text` text,
	`brief_json` text,
	`started_at` text,
	`ended_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`negotiation_id`) REFERENCES `negotiations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_calls_direction" CHECK("calls"."direction" IN ('OUTBOUND', 'INBOUND')),
	CONSTRAINT "ck_calls_purpose" CHECK("calls"."purpose" IN ('OPERATIONS', 'QUOTE', 'COMMIT', 'EXECUTION', 'INCIDENT', 'DELIVERY', 'RENEGOTIATION', 'ESCALATION')),
	CONSTRAINT "ck_calls_status" CHECK("calls"."status" IN ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_twilio_call_sid` ON `calls` (`twilio_call_sid`);--> statement-breakpoint
CREATE INDEX `idx_calls_operation_created` ON `calls` (`operation_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_calls_carrier_status` ON `calls` (`carrier_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`requested_carriers` integer NOT NULL,
	`max_parallel_calls` integer DEFAULT 3 NOT NULL,
	`strategy` text DEFAULT 'LOWEST_VALID_TOTAL' NOT NULL,
	`winning_quote_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_campaigns_status" CHECK("campaigns"."status" IN ('QUEUED', 'CALLING', 'COLLECTING_QUOTES', 'READY_TO_SELECT', 'COMPLETED', 'FAILED')),
	CONSTRAINT "ck_campaigns_requested_carriers" CHECK("campaigns"."requested_carriers" > 0),
	CONSTRAINT "ck_campaigns_max_parallel_calls" CHECK("campaigns"."max_parallel_calls" BETWEEN 1 AND 3),
	CONSTRAINT "ck_campaigns_strategy" CHECK("campaigns"."strategy" IN ('LOWEST_VALID_TOTAL', 'BALANCED_SCORE'))
);
--> statement-breakpoint
CREATE INDEX `idx_campaigns_operation` ON `campaigns` (`operation_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `carriers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`dispatcher_name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text,
	`score` integer DEFAULT 80 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "ck_carriers_score" CHECK("carriers"."score" BETWEEN 0 AND 100),
	CONSTRAINT "ck_carriers_active" CHECK("carriers"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_carriers_phone` ON `carriers` (`phone`);--> statement-breakpoint
CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`carrier_id` text NOT NULL,
	`status` text DEFAULT 'PROPOSED' NOT NULL,
	`mandate_id` text NOT NULL,
	`total_price_cents` integer NOT NULL,
	`currency` text DEFAULT 'MXN' NOT NULL,
	`pickup_date` text NOT NULL,
	`verbal_agreement_call_id` text,
	`confirmed_by` text,
	`exact_terms` text,
	`evidence_start_ms` integer,
	`evidence_end_ms` integer,
	`evidence_transcript_excerpt` text,
	`summary_channel` text,
	`summary_recipient` text,
	`summary_message` text,
	`summary_provider_id` text,
	`summary_sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verbal_agreement_call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_commitments_status" CHECK("commitments"."status" IN ('PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED', 'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION', 'FULFILLED', 'CANCELLED_BY_CARRIER', 'CANCELLED')),
	CONSTRAINT "ck_commitments_total_price" CHECK("commitments"."total_price_cents" > 0),
	CONSTRAINT "ck_commitments_evidence_start" CHECK("commitments"."evidence_start_ms" IS NULL OR "commitments"."evidence_start_ms" >= 0),
	CONSTRAINT "ck_commitments_evidence_end" CHECK("commitments"."evidence_end_ms" IS NULL OR "commitments"."evidence_end_ms" > 0),
	CONSTRAINT "ck_commitments_evidence_range" CHECK("commitments"."evidence_start_ms" IS NULL OR "commitments"."evidence_end_ms" IS NULL OR "commitments"."evidence_start_ms" < "commitments"."evidence_end_ms"),
	CONSTRAINT "ck_commitments_summary_channel" CHECK("commitments"."summary_channel" IS NULL OR "commitments"."summary_channel" IN ('SMS', 'EMAIL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_commitments_one_active_per_operation` ON `commitments` (`operation_id`) WHERE "commitments"."status" IN ('PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED', 'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION');--> statement-breakpoint
CREATE INDEX `idx_commitments_operation` ON `commitments` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_commitments_mandate` ON `commitments` (`mandate_id`);--> statement-breakpoint
CREATE TABLE `escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`call_id` text NOT NULL,
	`incident_id` text,
	`reason` text NOT NULL,
	`context_summary` text NOT NULL,
	`human_phone` text,
	`twilio_conference_sid` text,
	`status` text DEFAULT 'REQUESTED' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_escalations_status" CHECK("escalations"."status" IN ('REQUESTED', 'DIALING_HUMAN', 'HUMAN_JOINED', 'RESOLVED', 'FAILED'))
);
--> statement-breakpoint
CREATE INDEX `idx_escalations_operation` ON `escalations` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_escalations_status` ON `escalations` (`status`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`call_id` text,
	`type` text DEFAULT 'GENERAL' NOT NULL,
	`description` text NOT NULL,
	`reported_by` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`proposed_change_json` text,
	`evaluation_code` text,
	`mandate_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_incidents_status" CHECK("incidents"."status" IN ('OPEN', 'ALLOWED_CHANGE', 'NEEDS_ESCALATION', 'RESOLVED'))
);
--> statement-breakpoint
CREATE INDEX `idx_incidents_operation_status` ON `incidents` (`operation_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_incidents_mandate` ON `incidents` (`mandate_id`);--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`max_total_price_cents` integer NOT NULL,
	`currency` text DEFAULT 'MXN' NOT NULL,
	`pickup_date` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_mandates_version" CHECK("mandates"."version" > 0),
	CONSTRAINT "ck_mandates_status" CHECK("mandates"."status" IN ('ACTIVE', 'SUPERSEDED')),
	CONSTRAINT "ck_mandates_max_total_price" CHECK("mandates"."max_total_price_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mandates_operation_version` ON `mandates` (`operation_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mandates_one_active_per_operation` ON `mandates` (`operation_id`) WHERE "mandates"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX `idx_mandates_operation` ON `mandates` (`operation_id`);--> statement-breakpoint
CREATE TABLE `negotiations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`carrier_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`latest_offer_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_negotiations_status" CHECK("negotiations"."status" IN ('PENDING', 'CALLING', 'NEGOTIATING', 'QUOTED', 'REFUSED', 'NO_ANSWER', 'SELECTED', 'REJECTED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_negotiations_campaign_carrier` ON `negotiations` (`campaign_id`,`carrier_id`);--> statement-breakpoint
CREATE INDEX `idx_negotiations_operation_status` ON `negotiations` (`operation_id`,`status`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_name` text NOT NULL,
	`container_number` text NOT NULL,
	`origin` text NOT NULL,
	`destination` text NOT NULL,
	`service` text DEFAULT 'DRAYAGE' NOT NULL,
	`status` text DEFAULT 'CREATED' NOT NULL,
	`selected_carrier_id` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`selected_carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_operations_service" CHECK("operations"."service" = 'DRAYAGE'),
	CONSTRAINT "ck_operations_status" CHECK("operations"."status" IN ('CREATED', 'SOURCING', 'BOOKED', 'PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'NEEDS_RENEGOTIATION', 'ESCALATED', 'NEEDS_CARRIER', 'CANCELLED'))
);
--> statement-breakpoint
CREATE INDEX `idx_operations_status` ON `operations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_operations_container` ON `operations` (`container_number`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`negotiation_id` text NOT NULL,
	`carrier_id` text NOT NULL,
	`call_id` text,
	`total_price_cents` integer NOT NULL,
	`currency` text DEFAULT 'MXN' NOT NULL,
	`pickup_date` text NOT NULL,
	`notes` text,
	`valid` integer NOT NULL,
	`invalid_reason` text,
	`mandate_id` text NOT NULL,
	`valid_until` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`negotiation_id`) REFERENCES `negotiations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_quotes_total_price" CHECK("quotes"."total_price_cents" > 0),
	CONSTRAINT "ck_quotes_valid" CHECK("quotes"."valid" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_quotes_negotiation` ON `quotes` (`negotiation_id`);--> statement-breakpoint
CREATE INDEX `idx_quotes_operation_valid_price` ON `quotes` (`operation_id`,`valid`,`total_price_cents`);--> statement-breakpoint
CREATE INDEX `idx_quotes_mandate` ON `quotes` (`mandate_id`);