CREATE TABLE "mcp_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"transport" text NOT NULL,
	"status" text NOT NULL,
	"secret_ref" text,
	"tool_policy" jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_test" jsonb,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connectors_workspace_name_uq" ON "mcp_connectors" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "mcp_connectors_tenant_idx" ON "mcp_connectors" USING btree ("workspace_id","organization_id","id");