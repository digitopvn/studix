import { BlockList, isIP } from "node:net";

/**
 * Address classification for the SSRF policy. Non-public ranges (private, loopback, link-local, CGNAT,
 * multicast, documentation, reserved, unspecified) are refused unless the connector host is explicitly
 * allowlisted for local use; cloud metadata and link-local ranges are refused always.
 */

const NON_PUBLIC_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const NON_PUBLIC_V6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

/** Never reachable, even for allowlisted local hosts: link-local and cloud metadata endpoints. */
const ALWAYS_BLOCKED_V4: Array<[string, number]> = [
  ["169.254.0.0", 16],
  ["100.100.100.200", 32],
];
const ALWAYS_BLOCKED_V6: Array<[string, number]> = [
  ["fe80::", 10],
  ["fd00:ec2::254", 128],
];

function buildList(v4: Array<[string, number]>, v6: Array<[string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
}

const nonPublic = buildList(NON_PUBLIC_V4, NON_PUBLIC_V6);
const alwaysBlocked = buildList(ALWAYS_BLOCKED_V4, ALWAYS_BLOCKED_V6);

/** Expand an IPv6 address (any textual form, including an embedded dotted quad) to 8 hextets. */
function expandIPv6(address: string): number[] | undefined {
  let text = address.split("%")[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    const hex = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    text = text.slice(0, -dotted[1]!.length) + hex;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const hextets = [...left, ...new Array<number>(Math.max(fill, 0)).fill(0), ...right];
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff)
    ? hextets
    : undefined;
}

/** IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) IPv6 address. */
export function embeddedIPv4(address: string): string | undefined {
  const h = expandIPv6(address);
  if (!h) return undefined;
  const zeroPrefix = h.slice(0, 5).every((x) => x === 0);
  if (!zeroPrefix || (h[5] !== 0xffff && h[5] !== 0)) return undefined;
  if (h[5] === 0 && h[6] === 0) return undefined; // :: and ::1 are handled as IPv6
  return [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff].join(".");
}

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Decide whether a resolved address may be contacted. `allowPrivate` is set only for explicitly
 * allowlisted local/test hosts; metadata and link-local addresses stay blocked regardless.
 */
export function classifyAddress(address: string, options: { allowPrivate?: boolean } = {}): AddressVerdict {
  const family = isIP(address);
  if (family === 0) return { allowed: false, reason: "not an IP address" };
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return classifyAddress(v4, options);
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  if (alwaysBlocked.check(address, type)) {
    return { allowed: false, reason: "link-local or cloud metadata address" };
  }
  if (!options.allowPrivate && nonPublic.check(address, type)) {
    return { allowed: false, reason: "private, loopback or reserved address" };
  }
  return { allowed: true };
}
