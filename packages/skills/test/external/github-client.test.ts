import { EXTERNAL_SKILL_LIMITS } from "@studix/core";
import { createManualClock, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createGitHubSkillSource } from "../../src/external/index.ts";
import { createFakeGitHub, type FakeIntercept, skillMd } from "./fake-github.ts";

const TOKEN = "ghp_secretTOKEN1234567890";
const URL_ = "https://github.com/acme/skills";

function setup(intercept?: FakeIntercept, options: { token?: string; clock?: ReturnType<typeof createManualClock> } = {}) {
  const github = createFakeGitHub(
    [{ owner: "acme", repo: "skills", files: { "a/SKILL.md": skillMd("a") } }],
    intercept,
  );
  const sleeps: number[] = [];
  const source = createGitHubSkillSource({
    fetch: github.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { github, source, sleeps };
}

async function caught(promise: Promise<unknown>): Promise<StudixError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(StudixError);
    return err as StudixError;
  }
  throw new Error("expected a rejection");
}

describe("GitHub client behaviour", () => {
  it("sends fixed headers and the token only to api.github.com, with redirects refused", async () => {
    const { source, github } = setup(undefined, { token: TOKEN });
    await source.discover({ repositoryUrl: URL_ });
    expect(github.calls.length).toBeGreaterThan(0);
    for (const call of github.calls) {
      expect(call.url.origin).toBe("https://api.github.com");
      expect(call.redirect).toBe("error");
      expect(call.headers).toMatchObject({
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "studix-skill-import",
        authorization: `Bearer ${TOKEN}`,
      });
    }
  });

  it("omits Authorization without a token and never leaks the token into errors", async () => {
    const anonymous = setup();
    await anonymous.source.resolve({ repositoryUrl: URL_ });
    expect(anonymous.github.calls.every((c) => c.headers.authorization === undefined)).toBe(true);

    const authed = setup(() => new Response("{}", { status: 401 }), { token: TOKEN });
    const err = await caught(authed.source.resolve({ repositoryUrl: URL_ }));
    expect(err.code).toBe("UNAUTHENTICATED");
    const missing = await caught(setup(undefined, { token: TOKEN }).source.resolve({ repositoryUrl: `${URL_}x` }));
    for (const e of [err, missing]) {
      expect(JSON.stringify(e.toJSON())).not.toContain(TOKEN);
      expect(`${e.message} ${e.stack}`).not.toContain(TOKEN);
    }
  });

  it("maps 403 with rate-limit headers to RATE_LIMITED with retryAfterSeconds", async () => {
    const clock = createManualClock(new Date("2026-01-01T00:00:00Z"));
    const reset = String(clock.now().getTime() / 1000 + 120);
    const limited = () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    const err = await caught(setup(limited, { clock }).source.resolve({ repositoryUrl: URL_ }));
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryable: true, details: { retryAfterSeconds: 120 } });

    const retryAfter = () => new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    const err2 = await caught(setup(retryAfter).source.resolve({ repositoryUrl: URL_ }));
    expect(err2.details).toEqual({ retryAfterSeconds: 30 });

    const forbidden = await caught(setup(() => new Response("{}", { status: 403 })).source.resolve({ repositoryUrl: URL_ }));
    expect(forbidden.code).toBe("FORBIDDEN");
  });

  it("fails without following when a redirect is refused, after bounded retries", async () => {
    const { source, github, sleeps } = setup((call) => {
      if (call.redirect === "error") throw new TypeError("fetch failed: redirect mode is set to error");
      return Response.redirect("https://evil.example/", 302);
    });
    const err = await caught(source.resolve({ repositoryUrl: URL_ }));
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(github.calls).toHaveLength(3);
    expect(github.calls.every((c) => c.url.host === "api.github.com")).toBe(true);
    expect(sleeps).toEqual([250, 500]);
  });

  it("retries 5xx GETs and succeeds when GitHub recovers", async () => {
    let failures = 2;
    const { source } = setup(() => (failures-- > 0 ? new Response("oops", { status: 502 }) : undefined));
    await expect(source.resolve({ repositoryUrl: URL_ })).resolves.toMatchObject({ repository: "acme/skills" });
  });

  it("treats an unexpected response shape as a provider error", async () => {
    const { source } = setup(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    expect((await caught(source.resolve({ repositoryUrl: URL_ }))).code).toBe("PROVIDER_ERROR");
  });

  it("fails with TIMEOUT once the operation deadline passes", async () => {
    const clock = createManualClock(0);
    const { source } = setup(
      (call) => {
        if (call.url.pathname.includes("/git/trees/")) clock.advance(EXTERNAL_SKILL_LIMITS.maxRuntimeMs + 1);
        return undefined;
      },
      { clock },
    );
    const err = await caught(source.discover({ repositoryUrl: URL_ }));
    expect(err.code).toBe("TIMEOUT");
  });

  it("maps an aborted request to TIMEOUT", async () => {
    const { source } = setup(() => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expect((await caught(source.resolve({ repositoryUrl: URL_ }))).code).toBe("TIMEOUT");
  });
});
