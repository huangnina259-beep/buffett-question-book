CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question` text NOT NULL,
	`kind` text NOT NULL,
	`curated_slug` text,
	`previous_answer_id` text,
	`content_version` text NOT NULL,
	`response_json` text NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `answers_session_idx` ON `answers` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`answer_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`helpful` integer,
	`reason` text,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`answer_id`) REFERENCES `answers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_session_idx` ON `feedback` (`session_id`);--> statement-breakpoint
CREATE TABLE `request_windows` (
	`session_id` text NOT NULL,
	`scope` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`session_id`, `scope`, `window_start`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);