ALTER TABLE "provider_executions" ADD COLUMN "funding" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "funding" text DEFAULT 'operator' NOT NULL;