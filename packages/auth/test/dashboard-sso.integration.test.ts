import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { schema } from "@studix/database";
import { withTestDatabase } from "@studix/database/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardAuth, type DashboardAuth, type SsoProvider } from "../src/dashboard-auth.ts";

const BASE = "http://localhost:8787";
const db = withTestDatabase();

const SSO = {
  github: { clientId: "gh-client", clientSecret: "gh-secret" },
  google: { clientId: "google-client", clientSecret: "google-secret" },
};

function setup(sso: Parameters<typeof createDashboardAuth>[0]["sso"] = SSO): DashboardAuth {
  return createDashboardAuth({
    rateLimit: false,
    db: db.current.db,
    directory: db.current.repos.directory,
    secret: "test-dashboard-secret-0123456789-abcdef",
    baseUrl: BASE,
    sso,
  });
}

/** Identity the fake provider returns for the next code exchange. */
interface FakeIdentity {
  subject: string;
  email: string;
  verified: boolean;
  name?: string;
}

/**
 * Fake GitHub and Google OAuth endpoints at the fetch boundary, so Better Auth's real provider code runs
 * without network access. Each authorization code maps to one identity; token requests are recorded.
 */
class FakeProviders {
  readonly codes = new Map<string, FakeIdentity>();
  readonly tokenRequests: { provider: SsoProvider; body: URLSearchParams }[] = [];
  private readonly tokens = new Map<string, FakeIdentity>();

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (
      request.method === "POST" &&
      `${url.origin}${url.pathname}` === "https://github.com/login/oauth/access_token"
    )
      return json(await this.exchange("github", request));
    if (request.method === "POST" && `${url.origin}${url.pathname}` === "https://oauth2.googleapis.com/token")
      return json(await this.exchange("google", request));

    const identity = this.tokens.get(request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "");
    if (url.href === "https://api.github.com/user") {
      if (!identity) return json({ message: "Bad credentials" }, 401);
      return json({
        id: Number(identity.subject),
        login: `user${identity.subject}`,
        name: identity.name,
        email: null,
      });
    }
    if (url.href === "https://api.github.com/user/emails") {
      if (!identity) return json({ message: "Bad credentials" }, 401);
      // A GitHub user may hide every email address from the app.
      return json(
        identity.email ? [{ email: identity.email, primary: true, verified: identity.verified }] : [],
      );
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return json(GOOGLE_JWKS);
    throw new Error(`unexpected outbound request in test: ${request.method} ${url.href}`);
  };

  private async exchange(provider: SsoProvider, request: Request) {
    const body = new URLSearchParams(await request.text());
    this.tokenRequests.push({ provider, body });
    const identity = this.codes.get(body.get("code") ?? "");
    if (!identity) return { error: "invalid_grant" };
    const accessToken = `at-${provider}-${identity.subject}-${this.tokens.size}`;
    this.tokens.set(accessToken, identity);
    if (provider === "github")
      return { access_token: accessToken, token_type: "bearer", scope: "read:user,user:email" };
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: fakeIdToken({
        iss: "https://accounts.google.com",
        aud: SSO.google.clientId,
        sub: identity.subject,
        email: identity.email,
        email_verified: identity.verified,
        name: identity.name,
      }),
    };
  }
}

/** Google's signing key, served from the fake JWKS endpoint, so id tokens verify like real ones. */
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const GOOGLE_JWKS = {
  keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "fake", alg: "RS256", use: "sig" }],
};

/** A Google id token signed with the fake key. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "RS256", kid: "fake", typ: "JWT" })}.${part({ iat: now, exp: now + 3600, ...claims })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), googleKey.privateKey).toString("base64url")}`;
}

/** A browser on the dashboard origin: keeps cookies between calls to the Better Auth handler. */
class Browser {
  private readonly jar = new Map<string, string>();

  constructor(private readonly dashboard: DashboardAuth) {}

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(path: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ origin: BASE });
    if (this.jar.size) headers.set("cookie", this.cookie);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.dashboard.auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const [name, ...value] = pair!.split("=");
      const expired = attributes.some((a) => /max-age=0/i.test(a.trim()));
      if (expired || value.join("=") === "") this.jar.delete(name!.trim());
      else this.jar.set(name!.trim(), value.join("="));
    }
    return response;
  }

  /** POST sign-in/social (or link-social) with the dashboard's return URL; returns the provider authorize URL. */
  async start(provider: SsoProvider, path = "/sign-in/social"): Promise<URL> {
    const returnTo = path === "/link-social" ? "/#/account" : "/";
    const response = await this.request(path, {
      provider,
      callbackURL: returnTo,
      errorCallbackURL: returnTo,
    });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    return new URL(url);
  }

  /** The provider redirecting back to Studix. Returns where Studix redirects next. */
  async callback(provider: SsoProvider, query: Record<string, string>): Promise<URL> {
    const response = await this.request(`/callback/${provider}?${new URLSearchParams(query)}`);
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!, BASE);
  }

  hasSession(): boolean {
    return this.jar.has("studix.session_token");
  }
}

let fake: FakeProviders;

beforeEach(() => {
  fake = new FakeProviders();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.handle);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Full redirect round trip: the user approves at the provider, which answers with `identity`. */
async function signInWith(browser: Browser, provider: SsoProvider, identity: FakeIdentity, path?: string) {
  const authorize = await browser.start(provider, path);
  const code = `code-${provider}-${fake.codes.size}`;
  fake.codes.set(code, identity);
  return browser.callback(provider, { code, state: authorize.searchParams.get("state")! });
}

async function usersByEmail(email: string) {
  return db.current.db.select().from(schema.users).where(eq(schema.users.email, email));
}

async function accountsOf(userId: string) {
  return db.current.db.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, userId));
}

describe("dashboard SSO (GitHub and Google through Better Auth)", () => {
  it("leaves SSO off when no OAuth client is configured", async () => {
    const dashboard = setup({});
    expect(dashboard.ssoProviders).toEqual([]);
    for (const provider of ["github", "google"] as const) {
      const response = await new Browser(dashboard).request("/sign-in/social", {
        provider,
        callbackURL: "/",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(fake.tokenRequests).toHaveLength(0);
    expect(setup({ google: SSO.google }).ssoProviders).toEqual(["google"]);
  });

  it("signs a new GitHub user up with a linked account and a personal workspace", async () => {
    const dashboard = setup();
    expect(dashboard.ssoProviders).toEqual(["github", "google"]);
    const browser = new Browser(dashboard);
    const authorize = await browser.start("github");
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("gh-client");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
    expect(authorize.searchParams.get("state")).toBeTruthy();

    fake.codes.set("gh-code", { subject: "1001", email: "an@example.test", verified: true, name: "An" });
    const next = await browser.callback("github", {
      code: "gh-code",
      state: authorize.searchParams.get("state")!,
    });
    expect(next.pathname).toBe("/");
    expect(next.searchParams.get("error")).toBeNull();
    expect(browser.hasSession()).toBe(true);

    const session = await dashboard.resolveSession(new Headers({ cookie: browser.cookie }));
    expect(session?.user.email).toBe("an@example.test");
    expect(session?.role).toBe("owner");
    expect(session?.memberships).toHaveLength(1);
    const [account] = await accountsOf(session!.user.id);
    expect(account).toMatchObject({ providerId: "github", accountId: "1001", password: null });
    expect((await usersByEmail("an@example.test"))[0]!.emailVerified).toBe(true);
  });

  it("uses PKCE with Google and signs the user in again on the same account", async () => {
    const dashboard = setup();
    const identity = { subject: "g-42", email: "binh@example.test", verified: true, name: "Binh" };
    const first = new Browser(dashboard);
    const authorize = await first.start("google");
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    fake.codes.set("g-code", identity);
    await first.callback("google", { code: "g-code", state: authorize.searchParams.get("state")! });
    expect(first.hasSession()).toBe(true);
    const verifier = fake.tokenRequests[0]!.body.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );

    const second = new Browser(dashboard);
    await signInWith(second, "google", identity);
    const a = await dashboard.resolveSession(new Headers({ cookie: first.cookie }));
    const b = await dashboard.resolveSession(new Headers({ cookie: second.cookie }));
    expect(b?.user.id).toBe(a?.user.id);
    expect(await usersByEmail("binh@example.test")).toHaveLength(1);
    expect(await accountsOf(a!.user.id)).toHaveLength(1);
  });

  it("creates no session when the callback state is missing, forged or from another browser", async () => {
    const dashboard = setup();
    const victim = new Browser(dashboard);
    const authorize = await victim.start("github");
    fake.codes.set("gh-code", { subject: "7", email: "chi@example.test", verified: true });

    const missing = await victim.callback("github", { code: "gh-code" });
    expect(missing.searchParams.get("error")).toBe("state_not_found");

    const forged = await victim.callback("github", { code: "gh-code", state: "forged-state" });
    expect(forged.searchParams.get("error")).toBeTruthy();

    // A valid state replayed without the browser's state cookie (login CSRF / stolen link) is refused.
    const attacker = new Browser(dashboard);
    const replay = await attacker.callback("github", {
      code: "gh-code",
      state: authorize.searchParams.get("state")!,
    });
    expect(replay.searchParams.get("error")).toBe("state_mismatch");

    expect(victim.hasSession()).toBe(false);
    expect(attacker.hasSession()).toBe(false);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await usersByEmail("chi@example.test")).toHaveLength(0);
  });

  it("links a provider-verified email to an existing user whose email is verified", async () => {
    const dashboard = setup();
    const github = new Browser(dashboard);
    await signInWith(github, "github", { subject: "55", email: "dung@example.test", verified: true });
    const google = new Browser(dashboard);
    const next = await signInWith(google, "google", {
      subject: "g-55",
      email: "Dung@Example.test",
      verified: true,
    });
    expect(next.searchParams.get("error")).toBeNull();

    const [user] = await usersByEmail("dung@example.test");
    const session = await dashboard.resolveSession(new Headers({ cookie: google.cookie }));
    expect(session?.user.id).toBe(user!.id);
    expect((await accountsOf(user!.id)).map((a) => a.providerId).sort()).toEqual(["github", "google"]);
  });

  it("never links an email the provider has not verified", async () => {
    const dashboard = setup();
    await signInWith(new Browser(dashboard), "github", {
      subject: "66",
      email: "em@example.test",
      verified: true,
    });
    const attacker = new Browser(dashboard);
    const next = await signInWith(attacker, "google", {
      subject: "g-evil",
      email: "em@example.test",
      verified: false,
    });
    expect(next.searchParams.get("error")).toBe("account_not_linked");
    expect(attacker.hasSession()).toBe(false);
    const [user] = await usersByEmail("em@example.test");
    expect((await accountsOf(user!.id)).map((a) => a.providerId)).toEqual(["github"]);
  });

  it("does not link SSO into a password account whose email Studix never verified", async () => {
    const dashboard = setup();
    // Someone registers with the address first; they never proved they own it.
    const squatter = new Browser(dashboard);
    await squatter.request("/sign-up/email", {
      email: "giang@example.test",
      password: "squatter-password-123",
      name: "Squatter",
    });
    const owner = new Browser(dashboard);
    const next = await signInWith(owner, "google", {
      subject: "g-giang",
      email: "giang@example.test",
      verified: true,
    });
    expect(next.searchParams.get("error")).toBe("account_not_linked");
    expect(owner.hasSession()).toBe(false);
    const [user] = await usersByEmail("giang@example.test");
    expect(await accountsOf(user!.id)).toHaveLength(1);
  });

  it("lets a signed-in password user link GitHub with the same verified email", async () => {
    const dashboard = setup();
    const browser = new Browser(dashboard);
    await browser.request("/sign-up/email", {
      email: "ha@example.test",
      password: "ha-password-12345",
      name: "Ha",
    });
    const [user] = await usersByEmail("ha@example.test");

    const wrongEmail = await signInWith(
      browser,
      "github",
      { subject: "77", email: "other@example.test", verified: true },
      "/link-social",
    );
    expect(wrongEmail.searchParams.get("error")).toBe("email_does_not_match");
    expect(wrongEmail.hash).toBe("#/account");
    const unverified = await signInWith(
      browser,
      "github",
      { subject: "77", email: "ha@example.test", verified: false },
      "/link-social",
    );
    expect(unverified.searchParams.get("error")).toBe("unable_to_link_account");
    expect(await accountsOf(user!.id)).toHaveLength(1);

    const linked = await signInWith(
      browser,
      "github",
      { subject: "77", email: "ha@example.test", verified: true },
      "/link-social",
    );
    expect(linked.searchParams.get("error")).toBeNull();
    expect(`${linked.pathname}${linked.hash}`).toBe("/#/account");
    expect((await accountsOf(user!.id)).map((a) => a.providerId).sort()).toEqual(["credential", "github"]);

    // From now on GitHub signs in to the same user.
    const later = new Browser(dashboard);
    await signInWith(later, "github", { subject: "77", email: "ha@example.test", verified: true });
    expect((await dashboard.resolveSession(new Headers({ cookie: later.cookie })))?.user.id).toBe(user!.id);
  });

  it("refuses to create an account from an unverified provider email", async () => {
    const dashboard = setup();
    const browser = new Browser(dashboard);
    const next = await signInWith(browser, "github", {
      subject: "88",
      email: "khoa@example.test",
      verified: false,
    });
    expect(next.searchParams.get("error")).toBe("email_not_verified");
    expect(browser.hasSession()).toBe(false);
    expect(await usersByEmail("khoa@example.test")).toHaveLength(0);
  });

  it("refuses Google's direct id-token sign-in, which would skip state and PKCE", async () => {
    const dashboard = setup();
    const browser = new Browser(dashboard);
    const response = await browser.request("/sign-in/social", {
      provider: "google",
      callbackURL: "/",
      idToken: {
        token: fakeIdToken({
          iss: "https://accounts.google.com",
          aud: SSO.google.clientId,
          sub: "g-direct",
          email: "lan@example.test",
          email_verified: true,
        }),
      },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(browser.hasSession()).toBe(false);
    expect(await usersByEmail("lan@example.test")).toHaveLength(0);
  });

  it("refuses a GitHub identity without an email", async () => {
    const dashboard = setup();
    const browser = new Browser(dashboard);
    const next = await signInWith(browser, "github", { subject: "99", email: "", verified: false });
    expect(next.searchParams.get("error")).toBe("email_not_found");
    expect(browser.hasSession()).toBe(false);
  });
});
