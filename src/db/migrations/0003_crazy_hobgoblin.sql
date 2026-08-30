CREATE TABLE `__new_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text,
	`carrier_id` text,
	`negotiation_id` text,
	`actor_type` text DEFAULT 'CARRIER' NOT NULL,
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
	CONSTRAINT "ck_calls_direction" CHECK("__new_calls"."direction" IN ('OUTBOUND', 'INBOUND')),
	CONSTRAINT "ck_calls_actor_type" CHECK("__new_calls"."actor_type" IN ('INTERNAL_OPERATOR', 'CARRIER', 'DISPATCHER', 'DRIVER')),
	CONSTRAINT "ck_calls_purpose" CHECK("__new_calls"."purpose" IN ('OPERATIONS', 'QUOTE', 'COMMIT', 'EXECUTION', 'INCIDENT', 'DELIVERY', 'RENEGOTIATION', 'ESCALATION')),
	CONSTRAINT "ck_calls_status" CHECK("__new_calls"."status" IN ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED'))
);
--> statement-breakpoint
INSERT INTO `__new_calls`("id", "operation_id", "carrier_id", "negotiation_id", "twilio_call_sid", "realtime_session_id", "direction", "purpose", "status", "from_number", "to_number", "transcript_text", "brief_json", "started_at", "ended_at", "created_at") SELECT "id", "operation_id", "carrier_id", "negotiation_id", "twilio_call_sid", "realtime_session_id", "direction", "purpose", "status", "from_number", "to_number", "transcript_text", "brief_json", "started_at", "ended_at", "created_at" FROM `calls`;--> statement-breakpoint
DROP TABLE `calls`;--> statement-breakpoint
ALTER TABLE `__new_calls` RENAME TO `calls`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_twilio_call_sid` ON `calls` (`twilio_call_sid`);--> statement-breakpoint
CREATE INDEX `idx_calls_operation_created` ON `calls` (`operation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_carrier_status` ON `calls` (`carrier_id`,`status`);
