import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportJsonSchemas, PUBLISHED_SCHEMAS } from "../src/index.ts";

const SCHEMAS_DIR = join(import.meta.dirname, "..", "schemas");

describe("exportJsonSchemas", () => {
  it("exports a draft 2020-12 schema for each published zod schema", () => {
    const schemas = exportJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(PUBLISHED_SCHEMAS).sort());
    const ir = schemas["video-ir"];
    expect(ir.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ir.$id).toBe("studix:video-ir");
    expect(ir.required).toEqual(expect.arrayContaining(["schemaVersion", "format", "scenes", "timeline"]));
  });

  it("committed schemas/*.json match the zod source (run `pnpm schemas:export` after changes)", () => {
    const schemas = exportJsonSchemas();
    const files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json"));
    expect(files.sort()).toEqual(
      Object.keys(schemas)
        .map((n) => `${n}.schema.json`)
        .sort(),
    );
    for (const [name, schema] of Object.entries(schemas)) {
      const onDisk = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8"));
      expect(onDisk, name).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });
});
