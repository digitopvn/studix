import { describe, expect, it } from "vitest";
import { parseModelJson } from "../src/model-json-repair.ts";

describe("parseModelJson", () => {
  it("parses JSON inside a code fence, with prose around it", () => {
    expect(parseModelJson('Sure:\n```json\n{"beats":[1,2]}\n```\nDone.')).toEqual({ beats: [1, 2] });
  });

  it("parses JSON followed or preceded by prose", () => {
    expect(parseModelJson('{"a":1}\n\nI kept it short.')).toEqual({ a: 1 });
    expect(parseModelJson('Result: [{"a":"x}"}] hope this helps')).toEqual([{ a: "x}" }]);
  });

  it("repairs trailing commas, comments and typographic quotes, but not string contents", () => {
    expect(parseModelJson('{"a":[1,2,],// note\n"b":"x, ]",}')).toEqual({ a: [1, 2], b: "x, ]" });
    expect(parseModelJson("{“a”: “b”}")).toEqual({ a: "b" });
  });

  it("throws a SyntaxError when nothing can be recovered", () => {
    expect(() => parseModelJson("no json here")).toThrow(SyntaxError);
    expect(() => parseModelJson('{"a": tru')).toThrow(SyntaxError);
  });
});
