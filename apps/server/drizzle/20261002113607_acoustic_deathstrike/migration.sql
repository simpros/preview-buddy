ALTER TABLE `previews` ADD `last_activity_at` text;--> statement-breakpoint
ALTER TABLE `previews` ADD `expiry_reason` text;--> statement-breakpoint
ALTER TABLE `previews` ADD `ttl_ms` integer;--> statement-breakpoint
ALTER TABLE `previews` ADD `idle_ms` integer;
