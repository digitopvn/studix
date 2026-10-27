import { StudixError } from "@studix/shared";
import { validateVideoIR } from "./validate.ts";
import { unwrapValidation, type ValidationResult } from "./validation-result.ts";
import { VIDEO_IR_SCHEMA_VERSION, type VideoIR } from "./video-ir.ts";

/**
 * Upgrades a raw document from schema version `from` to `from + 1`. Migrations are pure functions over
 * plain JSON (no I/O, no randomness) so replays are deterministic. See README.md "Migration policy".
 */
export type VideoIRMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry keyed by source version. Version 1 is the first published schema, so no migrations exist yet;
 * adding v2 means bumping VIDEO_IR_SCHEMA_VERSION and registering `1: (doc) => ({ ...doc, schemaVersion: 2 })`.
 */
export const VIDEO_IR_MIGRATIONS: Readonly<Record<number, VideoIRMigration>> = Object.freeze({});

export interface MigrationOutcome {
  ir: VideoIR;
  fromVersion: number;
  toVersion: number;
  /** True when at least one migration ran (the caller should store a new version). */
  migrated: boolean;
}

function readVersion(doc: unknown): number {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new StudixError("VALIDATION", "VideoIR document must be a JSON object");
  }
  const version = (doc as Record<string, unknown>).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StudixError("VALIDATION", "VideoIR document has no valid integer schemaVersion", {
      details: { schemaVersion: version },
    });
  }
  return version;
}

/** Run the migration chain from the document's version to the current one. */
export function runMigrations(
  doc: unknown,
  migrations: Readonly<Record<number, VideoIRMigration>> = VIDEO_IR_MIGRATIONS,
  target: number = VIDEO_IR_SCHEMA_VERSION,
): { doc: Record<string, unknown>; fromVersion: number } {
  const fromVersion = readVersion(doc);
  if (fromVersion > target) {
    throw new StudixError(
      "VALIDATION",
      `VideoIR schemaVersion ${fromVersion} is newer than supported version ${target}`,
      {
        suggestedAction: "Upgrade Studix to a release that supports this document.",
        details: { fromVersion, target },
      },
    );
  }
  let current = structuredClone(doc) as Record<string, unknown>;
  for (let v = fromVersion; v < target; v++) {
    const step = migrations[v];
    if (!step) {
      throw new StudixError("INTERNAL", `No VideoIR migration registered from version ${v}`, {
        details: { fromVersion: v },
      });
    }
    current = step(current);
    if (current.schemaVersion !== v + 1) {
      throw new StudixError("INTERNAL", `VideoIR migration from ${v} did not set schemaVersion ${v + 1}`);
    }
  }
  return { doc: current, fromVersion };
}

/** Migrate any stored IR document to the current schema and validate it; throws on failure. */
export function migrateVideoIR(doc: unknown): MigrationOutcome {
  const { doc: migrated, fromVersion } = runMigrations(doc);
  const ir = unwrapValidation(validateVideoIR(migrated) as ValidationResult<VideoIR>, "VideoIR");
  return {
    ir,
    fromVersion,
    toVersion: VIDEO_IR_SCHEMA_VERSION,
    migrated: fromVersion !== VIDEO_IR_SCHEMA_VERSION,
  };
}
