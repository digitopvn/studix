DROP INDEX "storage_profiles_one_active_uq";--> statement-breakpoint
ALTER TABLE "storage_profiles" ADD COLUMN "workspace_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_profiles_one_active_per_scope_uq" ON "storage_profiles" USING btree (coalesce("workspace_id", '')) WHERE "storage_profiles"."active";