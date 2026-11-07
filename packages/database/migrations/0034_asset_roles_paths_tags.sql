ALTER TABLE "assets" ADD COLUMN "role" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_role_path_idx" ON "assets" USING btree ("workspace_id","role","path");--> statement-breakpoint
-- Backfill: render kind maps to the render role; other roles use the same words, boundaries and order as
-- inferAssetRole (file name without extension; sound roles for audio, picture roles for image and video).
-- Anything unclear stays `other`. Folders start as the role name.
UPDATE "assets" SET "role" = CASE
  WHEN "kind" = 'render' THEN 'render'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(storyboard|story[^a-z]?board)([^a-z]|$)' THEN 'storyboard'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(keyframes?|key[^a-z]?frames?)([^a-z]|$)' THEN 'keyframe'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(characters?|char|lead[^a-z]?sheet|turnaround)([^a-z]|$)' THEN 'character'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(backgrounds?|bg|backdrop|environment)([^a-z]|$)' THEN 'background'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(props?)([^a-z]|$)' THEN 'prop'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(vfx|particles?|explosions?)([^a-z]|$)' THEN 'vfx'
  WHEN "kind" = 'audio' AND lower("name") ~ '(^|[^a-z])(sfx|sound[^a-z]?effects?|whoosh|impact|foley|fx)([^a-z]|$)' THEN 'sfx'
  WHEN "kind" = 'audio' AND lower("name") ~ '(^|[^a-z])(bgm|music|score|soundtrack|theme)([^a-z]|$)' THEN 'bgm'
  WHEN "kind" = 'audio' AND lower("name") ~ '(^|[^a-z])(voice|vo|narration|dialogue|speech)([^a-z]|$)' THEN 'voice'
  WHEN "kind" IN ('image', 'video') AND lower("name") ~ '(^|[^a-z])(reference|ref|moodboard)([^a-z]|$)' THEN 'reference'
  ELSE 'other'
END
WHERE "role" = 'other';
--> statement-breakpoint
UPDATE "assets" SET "path" = "role" WHERE "role" <> 'other' AND "path" = '';
