ALTER TABLE "assets" ADD COLUMN "role" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_path_idx" ON "assets" USING btree ("workspace_id","project_id","path");
--> statement-breakpoint
-- Backfill (expand-then-contract: the columns above default to 'other', so old code keeps working).
-- 1. Renders keep their kind as role.
UPDATE "assets" SET "role" = 'render' WHERE "kind" = 'render' AND "role" = 'other';--> statement-breakpoint
-- 2. Audio placed on an IR audio track takes the role of the newest track that uses it.
UPDATE "assets" AS a SET "role" = CASE t.track_kind WHEN 'music' THEN 'bgm' WHEN 'sfx' THEN 'sfx' ELSE 'voice' END
FROM (
  SELECT DISTINCT ON (av.asset_id) av.asset_id, track->>'kind' AS track_kind
  FROM "project_versions" pv
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv."ir"->'audio') = 'array' THEN pv."ir"->'audio' ELSE '[]'::jsonb END) AS track
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pv."ir"->'assets') = 'array' THEN pv."ir"->'assets' ELSE '[]'::jsonb END) AS ref
  JOIN "asset_versions" av ON av."id" = ref->>'assetVersionId'
  WHERE ref->>'id' = track->>'assetId'
  ORDER BY av.asset_id, pv."created_at" DESC
) AS t
WHERE a."id" = t.asset_id AND a."kind" = 'audio' AND a."role" = 'other';--> statement-breakpoint
-- 3. What is left is labelled from the file name, the same words the application uses for new assets.
UPDATE "assets" SET "role" = CASE
  WHEN "name" ~* '(^|[^a-z])(sfx|foley|whoosh|impact|sound[-_ ]?effect)([^a-z]|$)' THEN 'sfx'
  WHEN "name" ~* '(^|[^a-z])(bgm|music|soundtrack|theme[-_ ]?song)([^a-z]|$)' THEN 'bgm'
  WHEN "name" ~* '(^|[^a-z])(voice|vo|voiceover|dialog(ue)?|narration|tts|speech)([^a-z]|$)' THEN 'voice'
  WHEN "name" ~* '(^|[^a-z])(vfx|particles?|overlay|glitch|fx)([^a-z]|$)' THEN 'vfx'
  WHEN "name" ~* '(^|[^a-z])storyboard([^a-z]|$)' THEN 'storyboard'
  WHEN "name" ~* '(^|[^a-z])(keyframe|key[-_ ]?frame|kf)([^a-z]|$)' THEN 'keyframe'
  WHEN "name" ~* '(^|[^a-z])(character|char|turnaround)([^a-z]|$)' THEN 'character'
  WHEN "name" ~* '(^|[^a-z])(background|bg|backdrop|environment|location)([^a-z]|$)' THEN 'background'
  WHEN "name" ~* '(^|[^a-z])(prop|props)([^a-z]|$)' THEN 'prop'
  WHEN "name" ~* '(^|[^a-z])(reference|ref|moodboard)([^a-z]|$)' THEN 'reference'
  ELSE "role" END
WHERE "role" = 'other';
