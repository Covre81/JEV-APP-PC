CREATE TABLE `router_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`session_id` text,
	`human_prompt_hash` text,
	`jev_decision` text,
	`final_provider` text NOT NULL,
	`model` text,
	`route_reason` text NOT NULL,
	`request_class` text,
	`http_status` integer,
	`outcome` text NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`cache_read_tokens` integer,
	`latency_ms` integer NOT NULL,
	`fallback_triggered` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `router_logs_created_at_idx` ON `router_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `router_logs_session_id_idx` ON `router_logs` (`session_id`);--> statement-breakpoint
CREATE INDEX `router_logs_prompt_hash_idx` ON `router_logs` (`human_prompt_hash`);