CREATE TABLE "workspace_skill_opt_outs" (
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_skill_opt_outs_workspace_id_skill_id_pk" PRIMARY KEY("workspace_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_skill_opt_outs" ADD CONSTRAINT "workspace_skill_opt_outs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skill_opt_outs" ADD CONSTRAINT "workspace_skill_opt_outs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;