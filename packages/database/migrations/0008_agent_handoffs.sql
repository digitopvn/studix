CREATE TABLE "agent_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"instructions" text NOT NULL,
	"input" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"output" jsonb,
	"output_digest" text,
	"usage" jsonb,
	"submitted_by_type" text,
	"submitted_by_id" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_handoffs_job_stage_idx" ON "agent_handoffs" USING btree ("job_id","stage","id");--> statement-breakpoint
CREATE INDEX "agent_handoffs_tenant_idx" ON "agent_handoffs" USING btree ("workspace_id","organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handoffs_pending_uq" ON "agent_handoffs" USING btree ("job_id","stage") WHERE "agent_handoffs"."status" = 'pending';