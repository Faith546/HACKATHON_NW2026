CREATE TABLE `call_timing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`stream_sid` text,
	`clock` text NOT NULL,
	`event_type` text NOT NULL,
	`raw_timestamp_ms` integer NOT NULL,
	`item_id` text,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_call_timing_clock" CHECK("call_timing_events"."clock" IN ('twilio_stream', 'openai_input', 'recording', 'local_observation'))
);
--> statement-breakpoint
CREATE INDEX `idx_call_timing_call_created` ON `call_timing_events` (`call_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text,
	`carrier_id` text,
	`negotiation_id` text,
	`actor_type` text DEFAULT 'CARRIER' NOT NULL,
	`twilio_call_sid` text,
	`twilio_stream_sid` text,
	`recording_sid` text,
	`recording_status` text,
	`recording_url` text,
	`recording_duration_seconds` integer,
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
	CONSTRAINT "ck_calls_direction" CHECK("__new_calls"."direction" IN ('OUTBOUND', 'INBOUND')),
	CONSTRAINT "ck_calls_actor_type" CHECK("__new_calls"."actor_type" IN ('INTERNAL_OPERATOR', 'CARRIER', 'DISPATCHER', 'DRIVER')),
	CONSTRAINT "ck_calls_purpose" CHECK("__new_calls"."purpose" IN ('OPERATIONS', 'QUOTE', 'COMMIT', 'EXECUTION', 'INCIDENT', 'DELIVERY', 'RENEGOTIATION', 'ESCALATION')),
	CONSTRAINT "ck_calls_status" CHECK("__new_calls"."status" IN ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED'))
);
--> statement-breakpoint
INSERT INTO `__new_calls`("id", "operation_id", "carrier_id", "negotiation_id", "actor_type", "twilio_call_sid", "realtime_session_id", "direction", "purpose", "status", "from_number", "to_number", "transcript_text", "brief_json", "started_at", "ended_at", "created_at") SELECT "id", "operation_id", "carrier_id", "negotiation_id", 'CARRIER', "twilio_call_sid", "realtime_session_id", "direction", "purpose", "status", "from_number", "to_number", "transcript_text", "brief_json", "started_at", "ended_at", "created_at" FROM `calls`;--> statement-breakpoint
DROP TABLE `calls`;--> statement-breakpoint
ALTER TABLE `__new_calls` RENAME TO `calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_twilio_call_sid` ON `calls` (`twilio_call_sid`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_twilio_stream_sid` ON `calls` (`twilio_stream_sid`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_recording_sid` ON `calls` (`recording_sid`);--> statement-breakpoint
CREATE INDEX `idx_calls_operation_created` ON `calls` (`operation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_carrier_status` ON `calls` (`carrier_id`,`status`);--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_caller_item_id` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_transcript` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_start_ms` integer;--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_end_ms` integer;
