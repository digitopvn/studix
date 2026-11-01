ALTER TABLE "provider_executions" ADD COLUMN "funding" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "funding" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
-- Backfill: spend on a workspace's or member's own key is recorded, not charged (ADR 0016).
UPDATE "provider_executions" pe
SET "funding" = CASE pc."owner_type" WHEN 'user' THEN 'member' ELSE 'workspace' END
FROM "jobs" j, "provider_connections" pc
WHERE pe."operation" = 'video.plan.claude'
  AND j."id" = pe."job_id"
  AND pc."id" = j."payload"->'planner'->>'providerConnectionId'
  AND pc."workspace_id" = pe."workspace_id";--> statement-breakpoint
UPDATE "provider_executions" pe
SET "funding" = CASE pc."owner_type" WHEN 'user' THEN 'member' ELSE 'workspace' END
FROM "job_model_snapshots" s, "provider_connections" pc
WHERE pe."provider" = 'pi'
  AND s."job_id" = pe."job_id"
  AND s."runtime" = 'pi'
  AND s."stage" = 'plan'
  AND pc."id" = s."snapshot"->>'connectionId'
  AND pc."workspace_id" = pe."workspace_id";--> statement-breakpoint
-- Planner and Pi runs only ever run on a stored connection, never on an operator key.
UPDATE "provider_executions" SET "funding" = 'workspace'
WHERE "funding" = 'operator' AND ("provider" = 'pi' OR "operation" = 'video.plan.claude');--> statement-breakpoint
UPDATE "usage_events" ue SET "funding" = pe."funding"
FROM "provider_executions" pe
WHERE ue."provider_execution_id" = pe."id" AND pe."funding" <> 'operator';--> statement-breakpoint
UPDATE "usage_events" SET "funding" = 'host'
WHERE "kind" = 'agent.run' AND "metadata"->>'mode' = 'host';
