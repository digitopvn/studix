ALTER TABLE "jobs" ADD COLUMN "deadline_window_ms" bigint;
--> statement-breakpoint
-- Existing jobs: the window is what the deadline was set to at creation (or, for a job parked at a gate, what it kept).
UPDATE "jobs" SET "deadline_window_ms" = GREATEST(0, (EXTRACT(EPOCH FROM ("deadline_at" - "created_at")) * 1000)::bigint) WHERE "deadline_at" IS NOT NULL;
--> statement-breakpoint
UPDATE "jobs" SET "deadline_window_ms" = "deadline_remaining_ms" WHERE "deadline_at" IS NULL AND "deadline_remaining_ms" IS NOT NULL;
