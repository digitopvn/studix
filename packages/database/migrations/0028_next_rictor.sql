CREATE TABLE "storage_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider_type" text NOT NULL,
	"endpoint" text,
	"bucket" text NOT NULL,
	"region" text NOT NULL,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"key_prefix" text DEFAULT '' NOT NULL,
	"access_key_ciphertext" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"access_key_hint" text NOT NULL,
	"secret_hint" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"last_test" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "storage_profile_id" text DEFAULT 'env' NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "storage_profile_id" text DEFAULT 'env' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_profiles_one_active_uq" ON "storage_profiles" USING btree ("active") WHERE "storage_profiles"."active";--> statement-breakpoint
CREATE INDEX "asset_versions_storage_key_idx" ON "asset_versions" USING btree ("workspace_id","storage_key");--> statement-breakpoint
CREATE INDEX "asset_versions_storage_profile_idx" ON "asset_versions" USING btree ("storage_profile_id");--> statement-breakpoint
CREATE INDEX "renders_storage_key_idx" ON "renders" USING btree ("workspace_id","storage_key");--> statement-breakpoint
CREATE INDEX "renders_storage_profile_idx" ON "renders" USING btree ("storage_profile_id");