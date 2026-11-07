import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { StudixError } from "@studix/shared";

/*
 * SSRF guard for storage endpoints an operator types into the dashboard. The server connects to that host
 * with stored credentials, so the endpoint must not reach the private network, the host itself or a cloud
 * metadata service. It is checked twice: when a profile is saved (resolve every address now) and on every
 * connection (the socket lookup refuses a blocked address), so a hostname that later resolves elsewhere
 * (DNS rebinding) still cannot be used. The S3 SDK never follows redirects. Endpoints from the deployment
 * environment (S3_ENDPOINT) are trusted configuration and are not guarded.
 */

export const STORAGE_PROVIDER_TYPES = ["cloudflare-r2", "aws-s3", "s3-compatible"] as const;
export type StorageProviderType = (typeof STORAGE_PROVIDER_TYPES)[number];

export interface EndpointPolicy {
  /**
   * Local development only: allow `http:` and loopback or private addresses (a MinIO on localhost).
   * Link-local and metadata addresses stay blocked even then.
   */
  allowLocal: boolean;
}

/** Addresses that are never reachable from a storage profile. */
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, including 169.254.169.254 metadata
ALWAYS_BLOCKED.addSubnet("100.100.100.200", 32, "ipv4"); // Alibaba Cloud metadata
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addAddress("::", "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6");
ALWAYS_BLOCKED.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6

/** Private and loopback ranges, allowed only with `allowLocal`. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.0.0.0", 24, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localdomain"];
const R2_SUFFIX = ".r2.cloudflarestorage.com";

function invalid(message: string, reason: string): StudixError {
  return new StudixError("VALIDATION", message, {
    retryable: false,
    details: { field: "endpoint", reason },
    suggestedAction:
      "Use the bucket provider's public HTTPS S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com.",
  });
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is checked as the IPv4 address it carries. */
function normalize(address: string): { address: string; family: "ipv4" | "ipv6" } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: "ipv4" };
  return { address, family: isIP(address) === 6 ? "ipv6" : "ipv4" };
}

/** Why an address may not be used, or undefined when it may. */
export function blockedAddressReason(address: string, policy: EndpointPolicy): string | undefined {
  const { address: a, family } = normalize(address);
  if (ALWAYS_BLOCKED.check(a, family)) return "link-local, metadata or reserved address";
  if (PRIVATE.check(a, family) && !policy.allowLocal) return "private or loopback address";
  return undefined;
}

export interface CheckedEndpoint {
  /** Normalized origin without a trailing slash or path. */
  endpoint: string;
  host: string;
}

/** Static checks: scheme, no credentials/path/query, no IP literal, the R2 host shape. */
export function assertEndpointShape(
  raw: string,
  providerType: StorageProviderType,
  policy: EndpointPolicy,
): CheckedEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid("The endpoint is not a valid URL", "not_a_url");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowLocal)) {
    throw invalid("The endpoint must use https", "scheme");
  }
  if (url.username || url.password) throw invalid("The endpoint must not contain credentials", "userinfo");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw invalid("The endpoint must be an origin without a path or query", "path");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const reason = blockedAddressReason(host, policy);
    // A public IP literal is refused too: it skips the hostname checks and is how SSRF payloads are written.
    if (reason || !policy.allowLocal)
      throw invalid("The endpoint must be a hostname, not an IP address", "ip");
  }
  if (!policy.allowLocal && (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))) {
    throw invalid("The endpoint must be a public hostname", "internal_host");
  }
  if (providerType === "cloudflare-r2" && !(host.endsWith(R2_SUFFIX) && host.length > R2_SUFFIX.length)) {
    throw invalid("A Cloudflare R2 endpoint must be https://<account>.r2.cloudflarestorage.com", "r2_host");
  }
  return { endpoint: url.origin, host };
}

type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/** Save-time check: the static rules plus every address the hostname resolves to now. */
export async function assertSafeStorageEndpoint(
  raw: string,
  providerType: StorageProviderType,
  policy: EndpointPolicy,
  resolve: Resolver = systemResolver,
): Promise<CheckedEndpoint> {
  const checked = assertEndpointShape(raw, providerType, policy);
  if (isIP(checked.host)) return checked;
  let addresses: string[];
  try {
    addresses = await resolve(checked.host);
  } catch {
    throw invalid("The endpoint hostname does not resolve", "dns");
  }
  if (addresses.length === 0) throw invalid("The endpoint hostname does not resolve", "dns");
  for (const address of addresses) {
    if (blockedAddressReason(address, policy)) {
      throw invalid("The endpoint resolves to a private or reserved address", "resolves_private");
    }
  }
  return checked;
}

/**
 * Connect-time check, used as the socket `lookup` of the storage client: resolves the host and refuses the
 * connection when any answer is blocked, so a rebinding DNS answer after the save-time check cannot be used.
 */
export function guardedLookup(policy: EndpointPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as unknown as Array<{ address: string; family: number }>;
      const bad = list.find((a) => blockedAddressReason(a.address, policy));
      if (bad || list.length === 0) {
        const refused = Object.assign(new Error("Storage endpoint resolves to a blocked address"), {
          code: "ESTORAGEBLOCKED",
        });
        return callback(refused, "", 0);
      }
      if (options.all) return (callback as (e: null, a: typeof list) => void)(null, list);
      const pick = list[0]!;
      callback(null, pick.address, pick.family);
    });
  };
}
