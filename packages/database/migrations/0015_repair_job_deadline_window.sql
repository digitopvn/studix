-- 0013 was journaled with a timestamp older than 0012's, and the migrator only applies migrations newer than the
-- last one a database recorded. A database that had applied 0012 before 0013 existed skipped it for good, so it
-- lacks this column. Adding it again is a no-op where 0013 did run.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "deadline_window_ms" bigint;
