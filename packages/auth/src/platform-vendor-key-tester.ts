export interface VendorKeyVerdict {
  verdict: "available" | "invalid" | "unverified";
  httpStatus?: number;
  note?: string;
}

/** A free, read-only authentication check against the vendor; `undefined` for vendors that offer none. */
export type VendorKeyTester = ((name: string, value: string) => Promise<VendorKeyVerdict | undefined>) & {
  /** Whether the key name has a free check at all. */
  supports?: (name: string) => boolean;
};

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
  OPENAI_API_KEY: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    unauthorized: "invalid",
  },
  GEMINI_API_KEY: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: (key) => ({ "x-goog-api-key": key }),
    unauthorized: "invalid",
  },
  REPLICATE_API_TOKEN: {
    url: "https://api.replicate.com/v1/account",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    unauthorized: "invalid",
  },
  RUNWAYML_API_SECRET: {
    url: "https://api.dev.runwayml.com/v1/organization",
    headers: (key) => ({ authorization: `Bearer ${key}`, "x-runway-version": "2024-11-06" }),
    unauthorized: "invalid",
  },
  HEYGEN_API_KEY: {
    url: "https://api.heygen.com/v2/user/remaining_quota",
    headers: (key) => ({ "x-api-key": key }),
    unauthorized: "invalid",
  },
  LEONARDO_API_KEY: {
    url: "https://cloud.leonardo.ai/api/rest/v1/me",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    unauthorized: "invalid",
  },
  CLOUDFLARE_API_TOKEN: {
    url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
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
  const test = async (name: string, value: string): Promise<VendorKeyVerdict | undefined> => {
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
  return Object.assign(test, { supports: (name: string) => Object.hasOwn(PROBES, name) });
}
