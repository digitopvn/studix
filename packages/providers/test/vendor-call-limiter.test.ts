import { describe, expect, it } from "vitest";
import { VendorCallLimiter } from "../src/index.ts";

describe("VendorCallLimiter", () => {
  it("queues past the limit, hands a freed slot to the next waiter, and drops a waiter that aborts", async () => {
    const limiter = new VendorCallLimiter();
    let release!: () => void;
    const first = limiter.run("v", 1, () => new Promise<void>((r) => (release = r)));
    const abort = new AbortController();
    const gaveUp = limiter.run("v", 1, async () => "never", abort.signal);
    const order: string[] = [];
    const next = limiter.run("v", 1, async () => order.push("next"));
    abort.abort();
    await expect(gaveUp).rejects.toMatchObject({ code: "CANCELLED" });
    expect(limiter.inFlight("v")).toBe(1);
    expect(order).toEqual([]);
    release();
    await Promise.all([first, next]);
    expect(order).toEqual(["next"]);
    expect(limiter.inFlight("v")).toBe(0);
    // Another vendor never waits on this one.
    await expect(limiter.run("w", 1, async () => "free")).resolves.toBe("free");
  });
});
