import { schema } from "@studix/database";
import { withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDashboardAuth, type DashboardAuth, WORKSPACE_HEADER } from "../src/dashboard-auth.ts";

const BASE = "http://localhost:8787";
const db = withTestDatabase();

function setup(rateLimit = false): DashboardAuth {
  return createDashboardAuth({
    rateLimit,
    db: db.current.db,
    directory: db.current.repos.directory,
    secret: "test-dashboard-secret-0123456789-abcdef",
    baseUrl: BASE,
  });
}

/** Call the Better Auth handler like a browser on the dashboard origin would. */
async function call(dashboard: DashboardAuth, path: string, body?: unknown, cookie?: string) {
  const headers = new Headers({ origin: BASE, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  const response = await dashboard.auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const cookies = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  return { response, cookie: cookies };
}

function cookieHeaders(cookie: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ cookie, ...extra });
}

describe("dashboard auth (Better Auth on the Studix tables)", () => {
  it("signs up, provisions a personal workspace, and resolves the session to a TenantContext", async () => {
    const dashboard = setup();
    const signUp = await call(dashboard, "/sign-up/email", {
      email: "linh@example.test",
      password: "correct-horse-battery",
      name: "Linh",
    });
    expect(signUp.response.status).toBe(200);
    expect(signUp.cookie).toContain("studix.session_token=");

    const session = await dashboard.resolveSession(cookieHeaders(signUp.cookie));
    expect(session).toBeDefined();
    expect(session!.user.email).toBe("linh@example.test");
    expect(session!.user.id).toMatch(/^usr_/);
    expect(session!.role).toBe("owner");
    expect(session!.memberships).toHaveLength(1);
    expect(session!.ctx).toMatchObject({
      organizationId: session!.memberships[0]!.organization.id,
      workspaceId: session!.memberships[0]!.workspace.id,
      actor: { type: "user", id: session!.user.id, role: "owner" },
    });

    // Password is stored hashed in auth_accounts, never in plaintext.
    const accounts = await db.current.db
      .select()
      .from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, session!.user.id));
    expect(accounts[0]!.password).toBeTruthy();
    expect(accounts[0]!.password).not.toContain("correct-horse-battery");
  });

  it("logs in with the right password only and invalidates the session on sign-out", async () => {
    const dashboard = setup();
    await call(dashboard, "/sign-up/email", {
      email: "minh@example.test",
      password: "another-long-password",
      name: "Minh",
    });
    const wrong = await call(dashboard, "/sign-in/email", {
      email: "minh@example.test",
      password: "not-the-password",
    });
    expect(wrong.response.status).toBe(401);

    const login = await call(dashboard, "/sign-in/email", {
      email: "minh@example.test",
      password: "another-long-password",
    });
    expect(login.response.status).toBe(200);
    const session = await dashboard.resolveSession(cookieHeaders(login.cookie));
    expect(session?.user.email).toBe("minh@example.test");
    // Login reuses the workspace created at signup.
    expect(session?.memberships).toHaveLength(1);

    const out = await call(dashboard, "/sign-out", {}, login.cookie);
    expect(out.response.status).toBe(200);
    expect(await dashboard.resolveSession(cookieHeaders(login.cookie))).toBeUndefined();
  });

  it("returns no session without a cookie and rejects a workspace the user does not belong to", async () => {
    const dashboard = setup();
    expect(await dashboard.resolveSession(new Headers())).toBeUndefined();
    const a = await call(dashboard, "/sign-up/email", {
      email: "a@example.test",
      password: "password-of-user-a",
      name: "A",
    });
    const b = await call(dashboard, "/sign-up/email", {
      email: "b@example.test",
      password: "password-of-user-b",
      name: "B",
    });
    const sessionB = await dashboard.resolveSession(cookieHeaders(b.cookie));
    const foreign = sessionB!.ctx.workspaceId;
    const error = await dashboard
      .resolveSession(cookieHeaders(a.cookie, { [WORKSPACE_HEADER]: foreign }))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(StudixError);
    expect((error as StudixError).code).toBe("FORBIDDEN");
  });

  it("rate limits repeated sign-in attempts when the limiter is on", async () => {
    const dashboard = setup(true);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const attempt = await call(dashboard, "/sign-in/email", {
        email: "nobody@example.test",
        password: "x".repeat(12),
      });
      statuses.push(attempt.response.status);
    }
    expect(statuses).toContain(429);
  });

  it("rejects short passwords and duplicate emails", async () => {
    const dashboard = setup();
    const short = await call(dashboard, "/sign-up/email", {
      email: "s@example.test",
      password: "short",
      name: "S",
    });
    expect(short.response.status).toBe(400);
    await call(dashboard, "/sign-up/email", {
      email: "dup@example.test",
      password: "first-password-1",
      name: "D",
    });
    const dup = await call(dashboard, "/sign-up/email", {
      email: "dup@example.test",
      password: "second-password-2",
      name: "D2",
    });
    expect(dup.response.status).toBeGreaterThanOrEqual(400);
  });
});
