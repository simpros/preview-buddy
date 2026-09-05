CREATE TABLE `api_tokens` (
	`token_hash` text PRIMARY KEY,
	`scope` text NOT NULL,
	`canonical_repo_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `previews` (
	`canonical_repo_id` text NOT NULL,
	`pr_id` integer NOT NULL,
	`slug` text NOT NULL,
	`db_name` text NOT NULL,
	`hostname` text NOT NULL,
	`app_image` text,
	`container_id` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`seeded_at` text,
	CONSTRAINT `previews_pk` PRIMARY KEY(`canonical_repo_id`, `pr_id`)
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`canonical_id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
