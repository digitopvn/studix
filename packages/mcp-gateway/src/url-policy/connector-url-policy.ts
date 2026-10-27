import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { StudixError } from "@studix/shared";
import { classifyAddress } from "./ip-address-ranges.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** DNS seam: production uses the system resolver; tests inject stubs (e.g. to simulate rebinding). */
export interface HostResolver {
  lookup(hostname: string): Promise<ResolvedAddress[]>;
}

export const systemHostResolver: HostResolver = {
  async lookup(hostname) {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  },
};

/** A validated destination: connect to `address` only, while TLS/Host keep using `url.hostname`. */
export interface PinnedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface ConnectorUrlPolicyOptions {
  /** Hosts (`host` or `host:port`, lowercase) allowed to use http and private addresses (local/test only). */
  insecureHosts?: string[];
  /** Studix's own origins; connectors pointing at them are refused. */
  selfOrigins?: string[];
  resolver?: HostResolver;
}

export interface ConnectorUrlPolicy {
  /** Static checks (scheme, credentials, recursion, literal IPs); no network access. */
  validate(raw: string | URL): URL;
  /** Static checks plus DNS: every answer must be allowed; the first one is pinned for the connection. */
  resolve(raw: string | URL): Promise<PinnedTarget>;
}

const MAX_URL_LENGTH = 2048;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function forbidden(message: string, url?: URL): StudixError {
  return new StudixError("FORBIDDEN", message, {
    retryable: false,
    suggestedAction: "Use a public https:// MCP endpoint.",
    ...(url ? { details: { host: url.host } } : {}),
  });
}

/** Strip IPv6 brackets from URL.hostname. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function createConnectorUrlPolicy(options: ConnectorUrlPolicyOptions = {}): ConnectorUrlPolicy {
  const insecure = new Set((options.insecureHosts ?? []).map((h) => h.toLowerCase()));
  const selfOrigins = new Set((options.selfOrigins ?? []).map((o) => new URL(o).origin));
  const selfHostnames = new Set([...selfOrigins].map((o) => new URL(o).hostname));
  const resolver = options.resolver ?? systemHostResolver;

  const isInsecureAllowed = (url: URL) => insecure.has(url.host.toLowerCase()) || insecure.has(url.hostname);

  const validate = (raw: string | URL): URL => {
    const text = String(raw);
    if (text.length > MAX_URL_LENGTH) throw new StudixError("VALIDATION", "Connector URL is too long");
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new StudixError("VALIDATION", "Connector URL is not a valid absolute URL");
    }
    url.hash = "";
    const local = isInsecureAllowed(url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw forbidden("Connector URL must use https", url);
    }
    if (url.username || url.password) {
      throw new StudixError("VALIDATION", "Connector URL must not embed credentials; use a secretRef");
    }
    // Recursion guard: a connector must never route back into Studix's own /mcp.
    if (selfOrigins.has(url.origin) || (selfHostnames.has(url.hostname) && !local)) {
      throw forbidden("Connector URL points back at Studix itself (recursion is not allowed)", url);
    }
    const host = bareHost(url.hostname);
    if (isIP(host)) {
      const verdict = classifyAddress(host, { allowPrivate: local });
      if (!verdict.allowed) throw forbidden(`Connector address refused: ${verdict.reason}`, url);
    } else if (!local && (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)))) {
      throw forbidden("Connector host refers to a local network name", url);
    }
    return url;
  };

  return {
    validate,
    async resolve(raw) {
      const url = validate(raw);
      const host = bareHost(url.hostname);
      const family = isIP(host);
      if (family !== 0) return { url, address: host, family: family === 6 ? 6 : 4 };
      let answers: ResolvedAddress[];
      try {
        answers = await resolver.lookup(host);
      } catch (error) {
        throw new StudixError("UNAVAILABLE", "Connector host could not be resolved", {
          cause: error,
          details: { host: url.host },
        });
      }
      if (answers.length === 0) {
        throw new StudixError("UNAVAILABLE", "Connector host has no addresses", {
          details: { host: url.host },
        });
      }
      const allowPrivate = isInsecureAllowed(url);
      // Every answer must pass: an attacker-controlled zone could mix public and internal records.
      for (const answer of answers) {
        const verdict = classifyAddress(answer.address, { allowPrivate });
        if (!verdict.allowed)
          throw forbidden(`Connector host resolves to a refused address: ${verdict.reason}`, url);
      }
      const pinned = answers[0]!;
      return { url, address: pinned.address, family: pinned.family };
    },
  };
}
