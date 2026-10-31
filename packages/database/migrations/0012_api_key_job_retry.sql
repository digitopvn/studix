-- `job:retry` was added to the editor, admin and owner roles after keys were issued. A key whose scopes were
-- exactly one of those roles minus `job:retry` is that role's key: give it the new scope so it keeps the role
-- (and the label) it was created with. Keys with any other scope set are custom and are left as issued.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.
UPDATE "api_keys" SET "scopes" = "scopes" || '["job:retry"]'::jsonb
WHERE NOT ("scopes" ? 'job:retry')
  AND EXISTS (
    SELECT 1
    FROM (VALUES
      ('["workspace:read","project:read","asset:read","project:write","job:cancel","job:retry","asset:write","approval:request"]'::jsonb),
      ('["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb)
    ) AS role_scopes(scopes)
    WHERE role_scopes.scopes @> ("api_keys"."scopes" || '["job:retry"]'::jsonb)
      AND ("api_keys"."scopes" || '["job:retry"]'::jsonb) @> role_scopes.scopes
  );
