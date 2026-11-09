import { describe, expect, it } from "vitest";
import { statIsZombie } from "../src/runner-sweep.ts";

describe("statIsZombie", () => {
  it("reads the state after the last parenthesis", () => {
    expect(statIsZombie("42 (sleep) Z 1 42 42 0 -1")).toBe(true);
    expect(statIsZombie("42 (sleep) S 1 42 42 0 -1")).toBe(false);
  });

  it("is not fooled by a command name that contains ') Z '", () => {
    expect(statIsZombie("7 (x) Z y) S 1 7 7 0 -1")).toBe(false);
    expect(statIsZombie("7 (x) S y) Z 1 7 7 0 -1")).toBe(true);
  });

  it("treats an unreadable stat as alive", () => {
    expect(statIsZombie("")).toBe(false);
  });
});
