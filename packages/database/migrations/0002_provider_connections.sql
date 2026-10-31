CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"auth_method" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_user_id" text,
	"owner_key" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"secret_ciphertext" text,
	"secret_hint" text,
	"last_test" jsonb,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_active_owner_uq" ON "provider_connections" USING btree ("workspace_id","provider","auth_method","owner_key") WHERE "provider_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "provider_connections_tenant_idx" ON "provider_connections" USING btree ("workspace_id","organization_id","id");