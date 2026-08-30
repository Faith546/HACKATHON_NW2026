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
ALTER TABLE `calls` ADD `twilio_stream_sid` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `recording_sid` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `recording_status` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `recording_url` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `recording_duration_seconds` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_twilio_stream_sid` ON `calls` (`twilio_stream_sid`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calls_recording_sid` ON `calls` (`recording_sid`);--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_caller_item_id` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_transcript` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_start_ms` integer;--> statement-breakpoint
ALTER TABLE `quotes` ADD `grounded_end_ms` integer;