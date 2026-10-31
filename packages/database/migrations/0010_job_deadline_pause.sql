ALTER TABLE "jobs" ADD COLUMN "deadline_remaining_ms" bigint;
--> statement-breakpoint
-- Jobs already parked keep the time they spent parked out of the deadline: updated_at is the park time.
UPDATE "jobs" SET "deadline_remaining_ms" = GREATEST(0, (EXTRACT(EPOCH FROM ("deadline_at" - "updated_at")) * 1000)::bigint), "deadline_at" = NULL WHERE "status" IN ('waiting_approval', 'waiting_host') AND "deadline_at" IS NOT NULL;
