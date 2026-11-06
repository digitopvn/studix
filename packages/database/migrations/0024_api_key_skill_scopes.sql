-- `skill:read` joined every role and `skill:write` joined the editor, admin, owner and operator roles after keys
-- were issued. A key whose scopes were exactly one of those roles minus the new scopes is that role's key: give it
-- the new scopes so it keeps the role (and the label) it was created with, and can use the skill tools.
-- Keys with any other scope set are custom and are left as issued.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.
UPDATE "api_keys" SET "scopes" = "scopes" || role_grants.added
FROM (VALUES
  ('["workspace:read","project:read","asset:read"]'::jsonb, '["skill:read"]'::jsonb),
  ('["workspace:read","project:read","asset:read","approval:decide"]'::jsonb, '["skill:read"]'::jsonb),
  ('["workspace:read","project:read","asset:read","project:write","job:cancel","job:retry","asset:write","approval:request"]'::jsonb, '["skill:read","skill:write"]'::jsonb),
  ('["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb, '["skill:read","skill:write"]'::jsonb),
  ('["workspace:read","project:read","project:write","job:cancel","job:retry","job:recover","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb, '["skill:read","skill:write"]'::jsonb)
) AS role_grants(legacy, added)
WHERE NOT ("api_keys"."scopes" ? 'skill:read')
  AND role_grants.legacy @> "api_keys"."scopes"
  AND "api_keys"."scopes" @> role_grants.legacy;
