CREATE TABLE "platform_credentials" (
	"name" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"secret_ciphertext" text,
	"secret_hint" text,
	"last_test" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "platform_credentials_updated_idx" ON "platform_credentials" USING btree ("updated_at");