-- `skill:read` and `skill:write` were added to the role matrix after keys were issued: every role reads
-- imported skills, editor and above also write them. A key whose scopes were exactly a role's set before that
-- is that role's key: give it the new scopes so it keeps the role (and the label) it was created with. Keys
-- with any other scope set are custom and are left as issued.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.
UPDATE "api_keys" SET "scopes" = "api_keys"."scopes" || role_scopes.added
FROM (VALUES
  -- viewer
  ('["workspace:read","project:read","asset:read"]'::jsonb, '["skill:read"]'::jsonb),
  -- reviewer
  ('["workspace:read","project:read","asset:read","approval:decide"]'::jsonb, '["skill:read"]'::jsonb),
  -- editor
  ('["workspace:read","project:read","asset:read","project:write","job:cancel","job:retry","asset:write","approval:request"]'::jsonb, '["skill:read","skill:write"]'::jsonb),
  -- admin and owner
  ('["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb, '["skill:read","skill:write"]'::jsonb)
) AS role_scopes(scopes, added)
WHERE NOT ("api_keys"."scopes" ? 'skill:read')
  AND role_scopes.scopes @> "api_keys"."scopes"
  AND "api_keys"."scopes" @> role_scopes.scopes;
