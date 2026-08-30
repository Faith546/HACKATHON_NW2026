PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_campaigns` (
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
	CONSTRAINT "ck_campaigns_status" CHECK("__new_campaigns"."status" IN ('QUEUED', 'CALLING', 'COLLECTING_QUOTES', 'READY_TO_SELECT', 'COMPLETED', 'FAILED')),
	CONSTRAINT "ck_campaigns_requested_carriers" CHECK("__new_campaigns"."requested_carriers" > 0),
	CONSTRAINT "ck_campaigns_max_parallel_calls" CHECK("__new_campaigns"."max_parallel_calls" BETWEEN 1 AND 3),
	CONSTRAINT "ck_campaigns_strategy" CHECK("__new_campaigns"."strategy" IN ('LOWEST_VALID_TOTAL', 'BALANCED_SCORE', 'BEST_WEIGHT_PRICE_RATIO'))
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "operation_id", "status", "requested_carriers", "max_parallel_calls", "strategy", "winning_quote_id", "created_at", "completed_at") SELECT "id", "operation_id", "status", "requested_carriers", "max_parallel_calls", "strategy", "winning_quote_id", "created_at", "completed_at" FROM `campaigns`;--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
CREATE INDEX `idx_campaigns_operation` ON `campaigns` (`operation_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `operations` ADD `weight_kg` integer DEFAULT 10000 NOT NULL;
