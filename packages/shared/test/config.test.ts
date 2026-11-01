import { describe, expect, it } from "vitest";
import { allowedHosts, loadConfig, StudixError, ssoClients } from "../src/index.ts";

describe("loadConfig", () => {
  it("applies development defaults without hardcoded public hostnames", () => {
    const cfg = loadConfig({ PORT: "9000" });
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.STUDIX_PUBLIC_URL).toBe("http://localhost:9000");
    expect(cfg.STUDIX_APP_URL).toBe("http://localhost:9000");
    expect(cfg.DECISION_PROVIDERS).toEqual(["rules"]);
    expect(cfg.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it("parses URLs, booleans and lists from env and treats empty strings as unset", () => {
    const cfg = loadConfig({
      STUDIX_PUBLIC_URL: "https://api.example.test/",
      STUDIX_APP_URL: "https://app.example.test",
      STUDIX_ALLOWED_HOSTS: "a.test, b.test",
      S3_FORCE_PATH_STYLE: "true",
      DECISION_PROVIDERS: "typesafe,openrouter,rules",
      OPENROUTER_API_KEY: "",
    });
    expect(cfg.STUDIX_PUBLIC_URL).toBe("https://api.example.test");
    expect(cfg.S3_FORCE_PATH_STYLE).toBe(true);
    expect(cfg.DECISION_PROVIDERS).toEqual(["typesafe", "openrouter", "rules"]);
    expect(cfg.OPENROUTER_API_KEY).toBeUndefined();
    expect(allowedHosts(cfg).sort()).toEqual(["a.test", "api.example.test", "app.example.test", "b.test"]);
  });

  it("enables an SSO provider only with both OAuth client keys and rejects a half-set pair", () => {
    expect(ssoClients(loadConfig({}))).toEqual({ github: undefined, google: undefined });
    expect(
      ssoClients(
        loadConfig({
          GOOGLE_CLIENT_ID: "google-id",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GITHUB_CLIENT_ID: "",
        }),
      ),
    ).toEqual({ github: undefined, google: { clientId: "google-id", clientSecret: "google-secret" } });
    let error: unknown;
    try {
      loadConfig({ GITHUB_CLIENT_ID: "gh-id", GOOGLE_CLIENT_SECRET: "google-secret-value" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StudixError);
    const message = (error as StudixError).message;
    expect(message).toContain("GITHUB_CLIENT_SECRET");
    expect(message).toContain("GOOGLE_CLIENT_ID");
    expect(message).not.toContain("google-secret-value");
  });

  it("requires public URLs and secrets in production and never echoes values", () => {
    let error: unknown;
    try {
      loadConfig({ NODE_ENV: "production", S3_SECRET_ACCESS_KEY: "super-secret-value" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StudixError);
    const e = error as StudixError;
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("STUDIX_PUBLIC_URL");
    expect(e.message).toContain("DATABASE_URL");
    expect(JSON.stringify(e.toJSON())).not.toContain("super-secret-value");
  });

  it("rejects malformed values", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
  });
});
