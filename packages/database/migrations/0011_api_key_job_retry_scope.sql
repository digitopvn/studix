-- Keys minted before job:retry existed hold exactly the old editor or the old admin/owner scope set, so the
-- dashboard labels them "custom" and they cannot retry jobs. Only those two exact sets gain job:retry;
-- hand-picked scope sets stay as they are.
UPDATE "api_keys" SET "scopes" = "scopes" || '["job:retry"]'::jsonb
WHERE jsonb_array_length("scopes") = 7
  AND "scopes" @> '["workspace:read","project:read","asset:read","project:write","job:cancel","asset:write","approval:request"]'::jsonb;
--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = "scopes" || '["job:retry"]'::jsonb
WHERE jsonb_array_length("scopes") = 12
  AND "scopes" @> '["workspace:read","project:read","project:write","job:cancel","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb;
