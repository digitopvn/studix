import { describe, expect, it } from "vitest";
import {
  DirectionOutput,
  directionIssues,
  sceneProps,
} from "../src/motion-graphic/motion-graphic-director-brief.ts";

const thread = "A 30 second launch film for our app";
const scene = (n: number, framing: string, copy: string[], extra: Record<string, unknown> = {}) => ({
  scene: n,
  shot: "the prompt bar types the thread",
  focal_words: ["film"],
  copy,
  hero: copy[0],
  props: ["bar"],
  framing,
  carry: "bar",
  ...extra,
});
const script = (scenes: unknown[], extra: Record<string, unknown> = {}) =>
  DirectionOutput.parse({
    direction: {
      concept: "c",
      motif: "m",
      rhythm: "r",
      thread,
      props: [{ id: "bar", kind: "Prompt", lines: [thread] }],
      scenes,
      ...extra,
    },
  }).direction;
const withThread = ["Generate", "16:9", thread];

describe("direction artifact script", () => {
  it("parses the script with harmless drift and finds nothing to repair in a complete one", () => {
    const d = script([
      scene(1, "close", withThread),
      scene(2, "Wide", withThread),
      scene(3, "close", withThread),
      scene(4, "medium", ["Rendering", "00:42", "Voice"], { props: "bar" }),
      scene(5, "close", withThread),
    ]);
    expect(d.props?.[0]?.kind).toBe("prompt");
    expect(d.scenes[1]?.framing).toBe("wide");
    expect(sceneProps(d, d.scenes[3]!)).toEqual([{ id: "bar", kind: "prompt", lines: [thread] }]);
    expect(directionIssues(d)).toEqual([]);
  });

  it("keeps over-long copy whole and sends it, gaps and broken references back as repair issues", () => {
    const long = "x".repeat(120);
    const d = script(
      [
        scene(1, "wide", ["Generate", "16:9", long]),
        scene(2, "wide", ["one", "two"], { carry: "player" }),
        scene(3, "medium", withThread),
        scene(4, "wide", withThread),
      ],
      { thread: undefined },
    );
    expect(d.scenes[0]?.copy?.[2]).toBe(long);
    const paths = directionIssues(d).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "direction.thread",
        "direction.scenes.0.copy.2",
        "direction.scenes.1.copy",
        "direction.scenes.1.framing",
        "direction.scenes.1.carry",
        "direction.scenes",
      ]),
    );
  });

  it("asks for the thread in the hook, the call to action and two middle scenes", () => {
    const d = script([
      scene(1, "close", ["a", "b", "c"]),
      scene(2, "wide", withThread),
      scene(3, "close", ["a", "b", "c"], { props: [] }),
      scene(4, "medium", ["a", "b", "c"], { props: [] }),
      scene(5, "close", withThread),
    ]);
    // Scene 1 shows the thread through its prompt bar prop; scenes 3 and 4 show neither.
    const messages = directionIssues(d).map((i) => i.message);
    expect(messages).toEqual(["the thread comes back verbatim in at least 2 middle scenes"]);
  });

  it("still reads a brief from before the artifact script", () => {
    const d = DirectionOutput.parse({
      direction: {
        concept: "c",
        motif: "m",
        rhythm: "r",
        scenes: [{ scene: 1, shot: "s", focalWords: ["a"] }],
      },
    }).direction;
    expect(d.thread).toBeUndefined();
    expect(d.scenes[0]?.copy).toBeUndefined();
  });
});
