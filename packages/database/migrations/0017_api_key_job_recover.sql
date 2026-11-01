-- `job:recover` was added to the admin and owner roles after keys were issued. A key whose scopes were exactly
-- that role's set minus `job:recover` is that role's key: give it the new scope so it keeps the role (and the
-- label) it was created with. Editor, reviewer, viewer and custom keys are left as issued.
-- jsonb containment in both directions compares the arrays as sets, so stored order does not matter.
UPDATE "api_keys" SET "scopes" = "scopes" || '["job:recover"]'::jsonb
WHERE NOT ("scopes" ? 'job:recover')
  AND "scopes" @> '["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb
  AND '["workspace:read","project:read","project:write","job:cancel","job:retry","asset:read","asset:write","approval:request","approval:decide","publish","audit:read","apikey:manage","member:manage"]'::jsonb @> "scopes";
