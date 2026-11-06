-- `skill:read` and `skill:write` joined the role matrix (external skills) after keys were issued. A key whose
-- scopes were exactly one role's set before that is that role's key: give it the scopes its role now carries,
-- so it keeps the role (and the label) it was created with. Keys with any other scope set are custom and are
-- left as issued, so they do not gain access to skills they were never granted.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.
UPDATE "api_keys" SET "scopes" = "api_keys"."scopes" || role_scopes.added
FROM (VALUES
  -- viewer
  ('["workspace:read","project:read","asset:read"]'::jsonb, '["skill:read"]'::jsonb),
  -- reviewer
  ('["workspace:read","project:read","asset:read","approval:decide"]'::jsonb, '["skill:read"]'::jsonb),
  -- editor
  ('["workspace:read","project:read","asset:read","project:write","job:cancel","job:retry","asset:write","approval:request"]'::jsonb, '["skill:read","skill:write"]'::jsonb),
  -- owner and admin
  ('["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb, '["skill:read","skill:write"]'::jsonb)
) AS role_scopes(previous, added)
WHERE NOT ("api_keys"."scopes" ? 'skill:read')
  AND role_scopes.previous @> "api_keys"."scopes"
  AND "api_keys"."scopes" @> role_scopes.previous;
