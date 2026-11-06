CREATE TABLE "external_skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"ref" text,
	"content_hash" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"imported_by_type" text NOT NULL,
	"imported_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_key" text NOT NULL,
	"source" jsonb NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"active_version_id" text,
	"latest_version_id" text NOT NULL,
	"upstream_status" text DEFAULT 'unknown' NOT NULL,
	"upstream_checked_at" timestamp with time zone,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by_type" text,
	"disabled_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_skill_versions" ADD CONSTRAINT "external_skill_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_skill_versions" ADD CONSTRAINT "external_skill_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_skill_versions" ADD CONSTRAINT "external_skill_versions_skill_id_external_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."external_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_skills" ADD CONSTRAINT "external_skills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_skills" ADD CONSTRAINT "external_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_skill_versions_number_uq" ON "external_skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "external_skill_versions_content_uq" ON "external_skill_versions" USING btree ("skill_id","content_hash");--> statement-breakpoint
CREATE INDEX "external_skill_versions_tenant_idx" ON "external_skill_versions" USING btree ("workspace_id","organization_id","skill_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_skills_source_uq" ON "external_skills" USING btree ("organization_id","workspace_id","source_key");--> statement-breakpoint
CREATE INDEX "external_skills_tenant_idx" ON "external_skills" USING btree ("workspace_id","organization_id","id");--> statement-breakpoint
CREATE INDEX "external_skills_name_idx" ON "external_skills" USING btree ("workspace_id","organization_id","name");