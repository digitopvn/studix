CREATE TABLE "project_storyboards" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision" integer NOT NULL,
	"version_id" text NOT NULL,
	"storyboard" jsonb NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "end_ms" integer;--> statement-breakpoint
ALTER TABLE "video_projects" ADD COLUMN "workflow_template" text;--> statement-breakpoint
ALTER TABLE "project_storyboards" ADD CONSTRAINT "project_storyboards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_storyboards" ADD CONSTRAINT "project_storyboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_storyboards" ADD CONSTRAINT "project_storyboards_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_storyboards" ADD CONSTRAINT "project_storyboards_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_storyboards_project_revision_uq" ON "project_storyboards" USING btree ("project_id","revision");