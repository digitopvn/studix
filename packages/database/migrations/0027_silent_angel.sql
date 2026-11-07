ALTER TABLE "external_skill_versions" ADD COLUMN "risk" jsonb;--> statement-breakpoint
ALTER TABLE "external_skills" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
CREATE INDEX "external_skills_platform_idx" ON "external_skills" USING btree ("id") WHERE "external_skills"."scope" = 'platform';