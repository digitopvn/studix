ALTER TABLE "project_versions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "project_versions" ADD COLUMN "feedback_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "project_versions_project_idempotency_uq" ON "project_versions" USING btree ("project_id","idempotency_key");