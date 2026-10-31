ALTER TABLE "approvals" ADD COLUMN "scope_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Connector approvals carried their tool + argument key only in the reason text; lift it into scope_key.
UPDATE "approvals" SET "scope_key" = substring("reason" from 'execute mutating connector tool (.+)$')
WHERE "action" = 'connector.execute' AND "reason" ~ 'execute mutating connector tool .+$';--> statement-breakpoint
-- Pending requests past their expiry can no longer be decided; close them so they do not hold the slot.
UPDATE "approvals" SET "status" = 'expired', "decided_at" = now()
WHERE "status" = 'pending' AND "expires_at" IS NOT NULL AND "expires_at" <= now();--> statement-breakpoint
-- Keep only the newest pending request per subject, action and scope.
UPDATE "approvals" a SET "status" = 'expired', "decided_at" = now()
WHERE a."status" = 'pending' AND EXISTS (
  SELECT 1 FROM "approvals" b
  WHERE b."status" = 'pending' AND b."workspace_id" = a."workspace_id" AND b."subject_type" = a."subject_type"
    AND b."subject_id" = a."subject_id" AND b."action" = a."action" AND b."scope_key" = a."scope_key"
    AND b."id" > a."id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_uq" ON "approvals" USING btree ("workspace_id","subject_type","subject_id","action","scope_key") WHERE "approvals"."status" = 'pending';