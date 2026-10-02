ALTER TABLE `previews` ADD `auth_mode` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `previews` ADD `auth_secret` text;--> statement-breakpoint
ALTER TABLE `previews` ADD `auth_basic_user` text;--> statement-breakpoint
ALTER TABLE `previews` ADD `auth_basic_password` text;