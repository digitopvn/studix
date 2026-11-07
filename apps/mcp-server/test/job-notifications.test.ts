import { createHmac, randomBytes } from "node:crypto";
import { createSecretBox } from "@studix/auth";
import type { TenantContext } from "@studix/core";
import type { JobChange, WorkspaceWebhookRecord } from "@studix/database";
import { createLogger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { startJobChangeFeed } from "../src/job-change-feed.ts";
import { createJobWebhookService, signWebhook, webhookEvent } from "../src/job-webhooks.ts";

const logger = createLogger({ service: "test" }, { level: "error" });

function change(id: string, status: JobChange["status"], at: number, stage: string | null = null): JobChange {
  return {
    id,
    workspaceId: "ws",
    organizationId: "org",
    projectId: "prj",
    status,
    stage,
    progress: 0,
    updatedAt: new Date(at),
  };
}

describe("job change feed", () => {
  it("reports status and stage changes once, not progress-only updates or re-read rows", async () => {
    let rows: JobChange[] = [];
    const seen: string[] = [];
    const feed = startJobChangeFeed({
      changes: { listChangedSince: async () => rows },
      onChanges: (changes) => void seen.push(...changes.map((c) => `${c.id}:${c.status}:${c.stage ?? ""}`)),
      logger,
      now: () => new Date(0),
      autoStart: false,
    });
    rows = [change("a", "running", 1000, "plan")];
    await feed.poll();
    rows = [change("a", "running", 1000, "plan"), { ...change("a", "running", 2000, "plan"), progress: 0.5 }];
    await feed.poll();
    rows = [change("a", "succeeded", 3000)];
    await feed.poll();
    expect(seen).toEqual(["a:running:plan", "a:succeeded:"]);
  });
});

describe("webhook signature", () => {
  it("signs `<t>.<body>` with HMAC-SHA256 and ids events by job, status and time", () => {
    const event = webhookEvent(change("job_1", "failed", 5000));
    expect(event.eventId).toBe("job_1:failed:5000");
    const body = JSON.stringify(event);
    const mac = createHmac("sha256", "whsec_x").update(`42.${body}`).digest("hex");
    expect(signWebhook("whsec_x", body, 42)).toBe(`t=42,v1=${mac}`);
  });
});

describe("webhook delivery", () => {
  it("posts each status change signed with the secret shown once at set time", async () => {
    let stored: WorkspaceWebhookRecord | undefined;
    const posts: { url: string; init: RequestInit }[] = [];
    const service = createJobWebhookService({
      repo: {
        get: async () => stored,
        put: async (_ctx, input) => (stored = { ...input, workspaceId: "ws", updatedAt: new Date() }),
        remove: async () => true,
        listForWorkspaces: async (ids) => (stored && ids.includes("ws") ? [stored] : []),
      },
      secrets: createSecretBox(randomBytes(32)),
      logger,
      allowLocal: true,
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({ url, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const ctx = {
      workspaceId: "ws",
      organizationId: "org",
      actor: { type: "user", id: "usr", role: "owner" },
    } as TenantContext;
    const saved = await service.set(ctx, "http://127.0.0.1:9/hook");
    expect(saved.secret).toMatch(/^whsec_/);
    expect(await service.get(ctx)).not.toHaveProperty("secret");

    await service.deliver([change("job_1", "succeeded", 7000)]);
    expect(posts).toHaveLength(1);
    const headers = posts[0]!.init.headers as Record<string, string>;
    const [t] = headers["studix-signature"]!.split(",");
    const unix = Number(t!.slice(2));
    expect(headers["studix-signature"]).toBe(signWebhook(saved.secret, posts[0]!.init.body as string, unix));
    expect(headers["studix-event-id"]).toBe("job_1:succeeded:7000");
  });
});
