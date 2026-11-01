-- `job:recover` is operator-only now: no workspace role holds it, so no API key may carry it. Owner and admin
-- keys that 0017 (or their creator) gave it fall back to exactly their role's set and keep their label.
UPDATE "api_keys" SET "scopes" = "scopes" - 'job:recover' WHERE "scopes" ? 'job:recover';
