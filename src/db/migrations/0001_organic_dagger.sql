ALTER TABLE `escalations` ADD `human_participant_call_sid` text;--> statement-breakpoint
ALTER TABLE `escalations` ADD `previous_operation_status` text DEFAULT 'CREATED' NOT NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `dispatcher_name` text;