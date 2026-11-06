-- `job:recover` now belongs to platform operators only: an attached Atlas prediction is collected with the
-- platform's provider key, so a tenant owner or admin holding it could pull another tenant's output into
-- their own job. Owners and admins could mint keys with it before (0017 even added it to their keys), and
-- no operator key exists yet, so every key that carries the scope drops it.
UPDATE "api_keys" SET "scopes" = "scopes" - 'job:recover'
WHERE "scopes" ? 'job:recover';
