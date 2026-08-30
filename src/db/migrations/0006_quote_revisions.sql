ALTER TABLE `quotes` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DROP INDEX `uq_quotes_negotiation`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_quotes_negotiation_revision` ON `quotes` (`negotiation_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_quotes_negotiation` ON `quotes` (`negotiation_id`);
