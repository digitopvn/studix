CREATE TABLE "platform_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_hint" text NOT NULL,
	"status" text NOT NULL,
	"last_test" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
