CREATE TABLE "workspace_multix_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"enabled" boolean,
	"wait_timeout_seconds" integer,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"voice_language_models" text,
	"updated_by_type" text,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_multix_settings" ADD CONSTRAINT "workspace_multix_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_multix_settings" ADD CONSTRAINT "workspace_multix_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;