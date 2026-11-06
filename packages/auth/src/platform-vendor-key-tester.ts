import type { VendorKeyTester, VendorKeyVerdict } from "./platform-credential-service.ts";

export interface VendorKeyTesterOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Free, read-only account lookups at fixed vendor hosts (never a host taken from input). Only vendors with
 * such an endpoint are listed; every other key stays `unverified` until a job uses it, because the Multix
 * CLI's own check only reports that a key is present, and a paid call is never made to test a key.
 */
const PROBES: Readonly<
  Record<
    string,
    {
      url: string;
      headers: (key: string) => Record<string, string>;
      unauthorized: VendorKeyVerdict["verdict"];
      note?: string;
    }
  >
> = {
  OPENROUTER_API_KEY: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    unauthorized: "invalid",
  },
  ELEVENLABS_API_KEY: {
    url: "https://api.elevenlabs.io/v1/user",
    headers: (key) => ({ "xi-api-key": key }),
    // A restricted key without the user-read permission is also refused here, so a 401 proves nothing.
    unauthorized: "unverified",
    note: "ElevenLabs refused the account lookup: the key is wrong or restricted without user access",
  },
};

export function createVendorKeyTester(options: VendorKeyTesterOptions = {}): VendorKeyTester {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (name, value) => {
    const probe = PROBES[name];
    if (!probe) return undefined;
    try {
      const res = await doFetch(probe.url, {
        method: "GET",
        headers: probe.headers(value),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      if (res.ok) return { verdict: "available", httpStatus: res.status };
      if (res.status === 401 || res.status === 403) {
        return {
          verdict: probe.unauthorized,
          httpStatus: res.status,
          ...(probe.note ? { note: probe.note } : {}),
        };
      }
      return {
        verdict: "unverified",
        httpStatus: res.status,
        note: `The vendor answered HTTP ${res.status}`,
      };
    } catch {
      return { verdict: "unverified", note: "The vendor could not be reached" };
    }
  };
}
