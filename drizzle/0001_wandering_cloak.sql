CREATE TABLE `generation_budget` (
	`id` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`reserved_micro_cny` integer DEFAULT 0 NOT NULL,
	`day` text NOT NULL,
	`day_attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`response_json` text,
	`reserved_micro_cny` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`usage_reported` integer DEFAULT false NOT NULL,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `generation_jobs_session_idx` ON `generation_jobs` (`session_id`);