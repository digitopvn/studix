CREATE TABLE "asset_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_version_id" text NOT NULL,
	"input_kind" text NOT NULL,
	"input_id" text NOT NULL,
	"role" text,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ir_node_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"node_id" text NOT NULL,
	"revision" integer NOT NULL,
	"digest" text NOT NULL,
	"content" jsonb NOT NULL,
	"version_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_version_nodes" (
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version_id" text NOT NULL,
	"kind" text NOT NULL,
	"node_id" text NOT NULL,
	"position" integer NOT NULL,
	"revision_id" text NOT NULL,
	CONSTRAINT "project_version_nodes_version_id_kind_node_id_pk" PRIMARY KEY("version_id","kind","node_id")
);
--> statement-breakpoint
CREATE TABLE "stage_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"stage" text NOT NULL,
	"cache_key" text NOT NULL,
	"output" jsonb NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ir_node_revisions" ADD CONSTRAINT "ir_node_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ir_node_revisions" ADD CONSTRAINT "ir_node_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ir_node_revisions" ADD CONSTRAINT "ir_node_revisions_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ir_node_revisions" ADD CONSTRAINT "ir_node_revisions_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_nodes" ADD CONSTRAINT "project_version_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_nodes" ADD CONSTRAINT "project_version_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_nodes" ADD CONSTRAINT "project_version_nodes_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_nodes" ADD CONSTRAINT "project_version_nodes_revision_id_ir_node_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."ir_node_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cache" ADD CONSTRAINT "stage_cache_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cache" ADD CONSTRAINT "stage_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cache" ADD CONSTRAINT "stage_cache_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_lineage_output_input_uq" ON "asset_lineage" USING btree ("asset_version_id","input_kind","input_id");--> statement-breakpoint
CREATE INDEX "asset_lineage_input_idx" ON "asset_lineage" USING btree ("workspace_id","input_kind","input_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ir_node_revisions_node_revision_uq" ON "ir_node_revisions" USING btree ("project_id","kind","node_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "ir_node_revisions_node_digest_uq" ON "ir_node_revisions" USING btree ("project_id","kind","node_id","digest");--> statement-breakpoint
CREATE INDEX "project_version_nodes_revision_idx" ON "project_version_nodes" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_cache_key_uq" ON "stage_cache" USING btree ("organization_id","workspace_id","stage","cache_key");