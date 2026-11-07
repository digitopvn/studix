-- `media:exec` was added to the editor, admin and owner roles after keys were issued. A key whose scopes were
-- exactly one of those roles' set before that is that role's key: give it the new scope so it keeps the role
-- (and the label) it was created with. Keys with any other scope set are custom and are left as issued.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.
UPDATE "api_keys" SET "scopes" = "api_keys"."scopes" || '["media:exec"]'::jsonb
FROM (VALUES
  -- editor
  ('["workspace:read","project:read","asset:read","skill:read","project:write","job:cancel","job:retry","asset:write","skill:write","approval:request"]'::jsonb),
  -- admin and owner
  ('["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","skill:read","skill:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb)
) AS role_scopes(scopes)
WHERE NOT ("api_keys"."scopes" ? 'media:exec')
  AND role_scopes.scopes @> "api_keys"."scopes"
  AND "api_keys"."scopes" @> role_scopes.scopes;
