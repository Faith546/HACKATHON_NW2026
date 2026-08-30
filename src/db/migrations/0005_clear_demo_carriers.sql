UPDATE `operations` SET `selected_carrier_id` = NULL WHERE `selected_carrier_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `commitments`;--> statement-breakpoint
DELETE FROM `quotes`;--> statement-breakpoint
UPDATE `calls` SET `carrier_id` = NULL, `negotiation_id` = NULL WHERE `carrier_id` IS NOT NULL OR `negotiation_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `negotiations`;--> statement-breakpoint
DELETE FROM `campaigns`;--> statement-breakpoint
DELETE FROM `carriers`;
