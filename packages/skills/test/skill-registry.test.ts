import { validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { getSkill, listSkills } from "../src/index.ts";

describe("skill registry", () => {
  it("lists brand-intro with its metadata and a JSON Schema input", () => {
    const skills = listSkills();
    expect(skills.map((s) => s.id)).toEqual(["brand-intro"]);
    const meta = skills[0]!;
    expect(meta).toMatchObject({ id: "brand-intro", version: 1, output: "video-ir" });
    expect(meta.description.length).toBeGreaterThan(20);
    expect(meta).not.toHaveProperty("run");
    expect(meta.inputSchema).toMatchObject({
      $id: "studix:creative-brief",
      type: "object",
      required: ["prompt"],
    });
    expect(Object.keys(meta.inputSchema.properties as object)).toContain("keyMessages");
  });

  it("hands out a schema copy so callers cannot mutate the registry", () => {
    const schema = getSkill("brand-intro").inputSchema;
    schema.type = "string";
    expect(getSkill("brand-intro").inputSchema.type).toBe("object");
  });

  it("runs a skill by id and rejects unknown ids", () => {
    const ir = getSkill("brand-intro").run({ prompt: "Giới thiệu quán phở", title: "Phở Thìn" });
    expect(validateVideoIR(ir).ok).toBe(true);
    expect(() => getSkill("nope")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});
