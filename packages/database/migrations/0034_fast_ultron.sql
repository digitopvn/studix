ALTER TABLE "assets" ADD COLUMN "role" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_role_path_idx" ON "assets" USING btree ("workspace_id","role","path");--> statement-breakpoint
-- Backfill: render kind maps to the render role; other roles are inferred from the media kind and file name
-- (same words as inferAssetRole), and anything unclear stays `other`. Folders start as the role name.
UPDATE "assets" SET "role" = CASE
  WHEN "kind" = 'render' THEN 'render'
  WHEN "kind" = 'audio' AND "name" ~* '(sfx|sound[ _-]?effect|whoosh|impact|foley|(^|[^a-z])fx([^a-z]|$))' THEN 'sfx'
  WHEN "kind" = 'audio' AND "name" ~* '(bgm|music|score|soundtrack|theme)' THEN 'bgm'
  WHEN "kind" = 'audio' AND "name" ~* '(voice|(^|[^a-z])vo([^a-z]|$)|narration|dialogue|speech|(^|[^a-z])line[0-9]*([^a-z]|$))' THEN 'voice'
  WHEN "kind" IN ('image', 'video') AND "name" ~* 'story[ _-]?board' THEN 'storyboard'
  WHEN "kind" IN ('image', 'video') AND "name" ~* 'key[ _-]?frame' THEN 'keyframe'
  WHEN "kind" IN ('image', 'video') AND "name" ~* '(character|(^|[^a-z])char([^a-z]|$)|lead[ _-]?sheet|turnaround)' THEN 'character'
  WHEN "kind" IN ('image', 'video') AND "name" ~* '(background|(^|[^a-z])bg([^a-z]|$)|backdrop|environment)' THEN 'background'
  WHEN "kind" IN ('image', 'video') AND "name" ~* '(^|[^a-z])props?([^a-z]|$)' THEN 'prop'
  WHEN "kind" IN ('image', 'video') AND "name" ~* '(vfx|particle|explosion|overlay)' THEN 'vfx'
  WHEN "kind" IN ('image', 'video') AND "name" ~* '(reference|(^|[^a-z])ref([^a-z]|$)|moodboard)' THEN 'reference'
  ELSE 'other'
END
WHERE "role" = 'other';
--> statement-breakpoint
UPDATE "assets" SET "path" = "role" WHERE "role" <> 'other' AND "path" = '';
