import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { migrateVideoIR, runMigrations, VIDEO_IR_MIGRATIONS, VIDEO_IR_SCHEMA_VERSION } from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

describe("VideoIR migrations", () => {
  it("has a migration for every version below the current one", () => {
    for (let v = 1; v < VIDEO_IR_SCHEMA_VERSION; v++) expect(VIDEO_IR_MIGRATIONS[v]).toBeTypeOf("function");
  });

  it("passes current documents through and validates them", () => {
    const outcome = migrateVideoIR(loadFixture("brand-intro-9x16.json"));
    expect(outcome).toMatchObject({ fromVersion: 1, toVersion: 1, migrated: false });
  });

  it("reads a stored title or text shot that carries a layout device as a plain headline", () => {
    // Production briefly stored a layout object on title and text shots; layouts are now their own shot type.
    const stored = loadFixture("brand-intro-9x16.json") as {
      scenes: { shots: Record<string, unknown>[] }[];
    };
    const layout = { kind: "chips", hub: "Studix", items: ["MCP", "API", "CLI"] };
    Object.assign(stored.scenes[0]?.shots[0] ?? {}, { layout });
    Object.assign(stored.scenes[1]?.shots[1] ?? {}, { layout });
    const { ir } = migrateVideoIR(stored);
    expect(ir.scenes[0]?.shots[0]).not.toHaveProperty("layout");
    expect(ir.scenes[1]?.shots[1]).not.toHaveProperty("layout");
  });

  it("refuses documents from the future or without a version", () => {
    expect(() => migrateVideoIR(loadFixture("invalid-future-version.json"))).toThrow(/newer than supported/);
    expect(() => migrateVideoIR({ title: "x" })).toThrow(StudixError);
    expect(() => migrateVideoIR([])).toThrow(StudixError);
  });

  it("runs a registered chain in order and requires each step to bump the version", () => {
    const chain = {
      1: (doc: Record<string, unknown>) => ({ ...doc, schemaVersion: 2, renamed: doc.old }),
      2: (doc: Record<string, unknown>) => ({ ...doc, schemaVersion: 3 }),
    };
    const input = { schemaVersion: 1, old: "value" };
    const { doc, fromVersion } = runMigrations(input, chain, 3);
    expect(doc).toEqual({ schemaVersion: 3, old: "value", renamed: "value" });
    expect(fromVersion).toBe(1);
    expect(input).toEqual({ schemaVersion: 1, old: "value" });
    expect(() => runMigrations({ schemaVersion: 1 }, { 1: (d) => d }, 2)).toThrow(
      /did not set schemaVersion/,
    );
    expect(() => runMigrations({ schemaVersion: 1 }, {}, 2)).toThrow(/No VideoIR migration/);
  });
});
