ALTER TABLE "jobs" ADD COLUMN "deadline_window_ms" bigint;
--> statement-breakpoint
-- Best effort for existing jobs: the gap between creation and deadline (it may already include gate wait or earlier retries), or the paused leftover.
UPDATE "jobs" SET "deadline_window_ms" = GREATEST(0, (EXTRACT(EPOCH FROM ("deadline_at" - "created_at")) * 1000)::bigint) WHERE "deadline_at" IS NOT NULL;
--> statement-breakpoint
UPDATE "jobs" SET "deadline_window_ms" = "deadline_remaining_ms" WHERE "deadline_at" IS NULL AND "deadline_remaining_ms" IS NOT NULL;
