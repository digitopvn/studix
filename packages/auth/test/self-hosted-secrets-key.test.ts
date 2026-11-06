import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { parseSecretKey } from "../src/secret-box.ts";
import { withSelfHostedSecretsKey } from "../src/self-hosted-secrets-key.ts";

const dir = () => mkdtempSync(join(tmpdir(), "studix-key-"));
const config = (env: Record<string, string>) => loadConfig({ NODE_ENV: "test", ...env });

describe("withSelfHostedSecretsKey", () => {
  it("leaves a hosted server without a key untouched", () => {
    const file = join(dir(), "secrets.key");
    const out = withSelfHostedSecretsKey(config({ STUDIX_SECRETS_KEY_FILE: file }));
    expect(out.STUDIX_SECRETS_KEY).toBeUndefined();
    expect(() => statSync(file)).toThrow();
  });

  it("generates a 0600 key file once and reuses it on the next start", () => {
    const file = join(dir(), "nested", "secrets.key");
    const env = { STUDIX_SELF_HOSTED: "true", STUDIX_SECRETS_KEY_FILE: file };
    const first = withSelfHostedSecretsKey(config(env)).STUDIX_SECRETS_KEY;
    expect(first).toBeDefined();
    expect(parseSecretKey(first as string)).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(withSelfHostedSecretsKey(config(env)).STUDIX_SECRETS_KEY).toBe(first);
    expect(readFileSync(file, "utf8").trim()).toBe(first);
  });

  it("prefers an explicit STUDIX_SECRETS_KEY and refuses a corrupt key file", () => {
    const file = join(dir(), "secrets.key");
    const explicit = Buffer.alloc(32, 7).toString("base64");
    const env = { STUDIX_SELF_HOSTED: "true", STUDIX_SECRETS_KEY_FILE: file };
    expect(
      withSelfHostedSecretsKey(config({ ...env, STUDIX_SECRETS_KEY: explicit })).STUDIX_SECRETS_KEY,
    ).toBe(explicit);
    writeFileSync(file, "not-a-key\n");
    expect(() => withSelfHostedSecretsKey(config(env))).toThrow();
  });
});
