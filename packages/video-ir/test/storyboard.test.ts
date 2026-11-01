import { describe, expect, it } from "vitest";
import {
  applyStoryboardPatch,
  canonicalJson,
  dependentsOf,
  invalidatedNodes,
  nodeDigests,
  pendingApprovals,
  type Storyboard,
  storyboardNodes,
  validateStoryboard,
} from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const storyboard = () => loadFixture("storyboard/two-scenes.json") as Storyboard;
const digestsOf = (sb: Storyboard) => nodeDigests(storyboardNodes(sb));
const issueCodes = (sb: Storyboard) => {
  const result = validateStoryboard(sb);
  return result.ok ? [] : result.issues.map((i) => `${i.code} ${i.path}`);
};

describe("Storyboard", () => {
  it("accepts the two-scene fixture", () => {
    const result = validateStoryboard(storyboard());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("reports unknown references, duplicate shot ids and continuity cycles", () => {
    const sb = storyboard();
    sb.scenes[0]!.shots[0]!.characterIds = ["ghost"];
    sb.scenes[1]!.shots[0]!.id = "establish";
    const codes = issueCodes(sb);
    expect(codes).toContain("unknown_reference /scenes/0/shots/0/characterIds/0");
    expect(codes).toContain("duplicate_id /scenes/1/shots/0/id");

    const looped = storyboard();
    looped.scenes[0]!.shots[0]!.dependsOn = ["greeting"];
    expect(issueCodes(looped)).toContain("cycle /scenes");
  });

  it("lists every level that still needs approval", () => {
    expect(pendingApprovals(storyboard())).toEqual([
      "storyboard",
      "scene:coffee",
      "shot:pour-close",
      "shot:steam",
    ]);
  });

  it("patching one shot invalidates only that shot and its dependents", () => {
    const before = storyboard();
    const after = applyStoryboardPatch(before, {
      ops: [{ op: "replace", path: "/scenes/1/shots/0/description", value: "Cận cảnh rót sữa đặc" }],
    });
    const changed = invalidatedNodes(digestsOf(before), digestsOf(after));
    // The continuity child `steam` and the enclosing scene follow; the other scene does not.
    expect(changed.sort()).toEqual(["scene:coffee", "shot:pour-close", "shot:steam"]);
    expect([...dependentsOf(storyboardNodes(after), ["shot:pour-close"])].sort()).toEqual(changed.sort());
  });

  it("a character change reaches every shot that shows the character, approvals reach nothing", () => {
    const before = storyboard();
    const recast = applyStoryboardPatch(before, {
      ops: [{ op: "replace", path: "/characters/0/description", value: "Tóc dài, tạp dề đỏ" }],
    });
    expect(invalidatedNodes(digestsOf(before), digestsOf(recast)).sort()).toEqual([
      "beat:greet",
      "character:lan",
      "scene:coffee",
      "scene:morning",
      "shot:greeting",
      "shot:pour-close",
      "shot:steam",
    ]);
    const approved = applyStoryboardPatch(before, {
      ops: [{ op: "replace", path: "/scenes/1/shots/1/approval", value: { status: "approved" } }],
    });
    expect(invalidatedNodes(digestsOf(before), digestsOf(approved))).toEqual([]);
  });

  it("canonical JSON ignores key order and undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { y: 1, x: 0 }] } })).toBe(
      '{"a":{"c":[2,{"x":0,"y":1}]},"b":1}',
    );
  });

  it("rejects a dependency graph with a cycle or a dangling edge", () => {
    expect(() => nodeDigests([{ key: "a", content: 1, dependsOn: ["b"] }])).toThrow(/unknown node "b"/);
    expect(() =>
      nodeDigests([
        { key: "a", content: 1, dependsOn: ["b"] },
        { key: "b", content: 2, dependsOn: ["a"] },
      ]),
    ).toThrow(/cycle/);
  });
});
