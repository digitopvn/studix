-- `skill:read` and `skill:write` joined the role matrix after keys were issued. A key whose scopes were exactly a
-- role's earlier set is that role's key: give it the new skill scopes so it keeps the role (and the label) it was
-- created with. Custom keys, and keys that already carry a skill scope, are left as issued.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.

-- viewer: read-only.
UPDATE "api_keys" SET "scopes" = "scopes" || '["skill:read"]'::jsonb
WHERE NOT ("scopes" ? 'skill:read')
  AND "scopes" @> '["workspace:read","project:read","asset:read"]'::jsonb
  AND '["workspace:read","project:read","asset:read"]'::jsonb @> "scopes";
--> statement-breakpoint
-- reviewer: read plus approval decisions.
UPDATE "api_keys" SET "scopes" = "scopes" || '["skill:read"]'::jsonb
WHERE NOT ("scopes" ? 'skill:read')
  AND "scopes" @> '["workspace:read","project:read","asset:read","approval:decide"]'::jsonb
  AND '["workspace:read","project:read","asset:read","approval:decide"]'::jsonb @> "scopes";
--> statement-breakpoint
-- editor: read and write.
UPDATE "api_keys" SET "scopes" = "scopes" || '["skill:read","skill:write"]'::jsonb
WHERE NOT ("scopes" ? 'skill:read')
  AND "scopes" @> '["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request"]'::jsonb
  AND '["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request"]'::jsonb @> "scopes";
--> statement-breakpoint
-- owner and admin: every tenant permission.
UPDATE "api_keys" SET "scopes" = "scopes" || '["skill:read","skill:write"]'::jsonb
WHERE NOT ("scopes" ? 'skill:read')
  AND "scopes" @> '["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb
  AND '["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb @> "scopes";
