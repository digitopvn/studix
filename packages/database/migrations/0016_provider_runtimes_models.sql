CREATE TABLE "job_model_snapshots" (
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"runtime" text NOT NULL,
	"stage" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_user_id" text DEFAULT '' NOT NULL,
	"stage" text NOT NULL,
	"runtime" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"allow_fallback" boolean DEFAULT false NOT NULL,
	"fallbacks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "runtimes" jsonb DEFAULT '["claude"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "billing_source" text DEFAULT 'usage_based' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_model_snapshots" ADD CONSTRAINT "job_model_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_model_snapshots" ADD CONSTRAINT "job_model_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_model_snapshots" ADD CONSTRAINT "job_model_snapshots_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_preferences" ADD CONSTRAINT "model_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_preferences" ADD CONSTRAINT "model_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_preferences" ADD CONSTRAINT "model_preferences_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_model_snapshots_uq" ON "job_model_snapshots" USING btree ("job_id","runtime","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "model_preferences_scope_uq" ON "model_preferences" USING btree ("workspace_id","scope_user_id","stage","runtime");--> statement-breakpoint
CREATE INDEX "model_preferences_tenant_idx" ON "model_preferences" USING btree ("workspace_id","organization_id");--> statement-breakpoint
CREATE INDEX "model_preferences_connection_idx" ON "model_preferences" USING btree ("connection_id");