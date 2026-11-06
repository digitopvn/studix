import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../src/index.ts";

function ok(text: string) {
  const parsed = parseSkillMarkdown(text);
  if (!parsed.ok) throw new Error(`expected a valid skill, got: ${parsed.reason}`);
  return parsed;
}

function reason(text: string): string {
  const parsed = parseSkillMarkdown(text);
  if (parsed.ok) throw new Error("expected an invalid skill");
  return parsed.reason;
}

describe("parseSkillMarkdown", () => {
  it("parses name, description, license, metadata and body", () => {
    const parsed = ok(
      [
        "---",
        "name: PDF Tools",
        "description: Work with PDF files. # trailing comment",
        "license: Apache-2.0",
        "allowed-tools: Read Write",
        "metadata:",
        "  author: acme",
        '  version: "1.2"',
        "---",
        "# Body",
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      name: "PDF Tools",
      slug: "pdf-tools",
      description: "Work with PDF files.",
      license: "Apache-2.0",
      metadata: { "allowed-tools": "Read Write", author: "acme", version: "1.2" },
      body: "# Body",
    });
  });

  it("supports quoted strings and escapes", () => {
    const parsed = ok(['---', `name: "Kỹ năng \\"video\\""`, "description: 'It''s: quoted'", "---"].join("\n"));
    expect(parsed.name).toBe('Kỹ năng "video"');
    expect(parsed.slug).toBe("ky-nang-video");
    expect(parsed.description).toBe("It's: quoted");
  });

  it("supports literal and folded block scalars and plain continuation lines", () => {
    const literal = ok(["---", "name: a", "description: |", "  line one", "  line two", "", "---"].join("\n"));
    expect(literal.description).toBe("line one\nline two");
    const folded = ok(["---", "name: a", "description: >-", "  folded one", "  folded two", "", "  para", "---"].join("\n"));
    expect(folded.description).toBe("folded one folded two\npara");
    const plain = ok(["---", "name: a", "description: starts here", "  and continues", "---"].join("\r\n"));
    expect(plain.description).toBe("starts here and continues");
  });

  it("joins simple lists into metadata strings", () => {
    const parsed = ok(["---", "name: a", "description: b", "tags: [video, audio]", "tools:", "  - Read", "  - Write", "---"].join("\n"));
    expect(parsed.metadata).toEqual({ tags: "video, audio", tools: "Read, Write" });
  });

  it("reports missing or empty required fields", () => {
    expect(reason("---\ndescription: x\n---\n")).toMatch(/name/);
    expect(reason("---\nname: x\n---\n")).toMatch(/description/);
    expect(reason('---\nname: ""\ndescription: x\n---\n')).toMatch(/name.*empty/);
  });

  it("reports a missing or unclosed frontmatter", () => {
    expect(reason("# Just markdown\n")).toMatch(/no YAML frontmatter/);
    expect(reason("---\nname: x\ndescription: y\n")).toMatch(/not closed/);
  });

  it.each([
    ["anchors", "---\nname: &a x\ndescription: y\n---\n"],
    ["aliases", "---\nname: x\ndescription: *a\n---\n"],
    ["tags", "---\nname: !!python/object x\ndescription: y\n---\n"],
    ["flow maps", "---\nname: x\ndescription: {a: b}\n---\n"],
    ["deep nesting", "---\nname: x\ndescription: y\nmetadata:\n  a: 1\n    b: 2\n---\n"],
    ["duplicate keys", "---\nname: x\nname: y\ndescription: y\n---\n"],
    ["unterminated quotes", '---\nname: "x\ndescription: y\n---\n'],
    ["a top-level list", "---\n- a\n- b\n---\n"],
    ["tab indentation", "---\nname: x\ndescription: y\nmetadata:\n\ta: b\n---\n"],
  ])("rejects %s", (_label, text) => {
    expect(reason(text)).toMatch(/Invalid frontmatter/);
  });

  it("enforces size bounds", () => {
    expect(reason(`---\nname: ${"n".repeat(101)}\ndescription: y\n---\n`)).toMatch(/name.*100/);
    expect(reason(`---\nname: x\ndescription: ${"d".repeat(2001)}\n---\n`)).toMatch(/description.*2000/);
    expect(reason(`---\nname: x\ndescription: y\nfiller: ${"z".repeat(17_000)}\n---\n`)).toMatch(/too long/);
    expect(reason(`---\n${"# c\n".repeat(500)}name: x\n---\n`)).toMatch(/too long/);
    const long = ok(`---\nname: x\ndescription: y\nnote: ${"v".repeat(600)}\n---\n`);
    expect(long.metadata.note?.length).toBe(500);
  });

  it("refuses NUL bytes", () => {
    expect(reason("---\nname: x\u0000\ndescription: y\n---\n")).toMatch(/NUL/);
  });
});
