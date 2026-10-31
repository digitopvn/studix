import { createHash } from "node:crypto";
import { StudixError } from "@studix/shared";
import type { VideoIR } from "./video-ir.ts";

/**
 * One addressable piece of a document (`shot:<id>`, `scene:<id>`, `asset:<id>`, ...) with its own content
 * and the nodes it depends on. A node's digest covers its content and the digests of its dependencies, so
 * a change propagates to every dependent and to nothing else.
 */
export interface DependencyNode {
  key: string;
  /** JSON content of the node itself, excluding what it reaches through `dependsOn`. */
  content: unknown;
  dependsOn: readonly string[];
}

/** JSON with object keys sorted and `undefined` members dropped: equal values always serialize the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .filter((k) => obj[k] !== undefined)
        .map((k) => [k, obj[k]]),
    );
  });
}

/** Lowercase hex sha256 of the canonical JSON of `value`. */
export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Merkle digest per node key. Throws VALIDATION on a dependency that is not a node, or on a cycle (a
 * cycle has no well-defined digest).
 */
export function nodeDigests(nodes: readonly DependencyNode[]): Map<string, string> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const digests = new Map<string, string>();
  const visiting = new Set<string>();
  const visit = (key: string, from?: string): string => {
    const done = digests.get(key);
    if (done) return done;
    const node = byKey.get(key);
    if (!node)
      throw new StudixError("VALIDATION", `"${from}" depends on unknown node "${key}"`, {
        details: { from, key },
      });
    if (visiting.has(key))
      throw new StudixError("VALIDATION", `dependency cycle through "${key}"`, { details: { key } });
    visiting.add(key);
    const deps = [...new Set(node.dependsOn)].sort().map((d) => [d, visit(d, key)]);
    visiting.delete(key);
    const digest = contentDigest({ content: node.content, deps });
    digests.set(key, digest);
    return digest;
  };
  for (const node of nodes) visit(node.key);
  return digests;
}

/**
 * Keys of `next` whose digest differs from `previous` (or that are new): exactly the nodes a change
 * invalidated. Everything else can reuse work cached under its unchanged digest.
 */
export function invalidatedNodes(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): string[] {
  return [...next].filter(([key, digest]) => previous.get(key) !== digest).map(([key]) => key);
}

/** Every node that transitively depends on one of `keys` (the keys themselves included). */
export function dependentsOf(nodes: readonly DependencyNode[], keys: Iterable<string>): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) reverse.set(dep, [...(reverse.get(dep) ?? []), node.key]);
  }
  const out = new Set<string>();
  const queue = [...keys];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (out.has(key)) continue;
    out.add(key);
    queue.push(...(reverse.get(key) ?? []));
  }
  return out;
}

export const nodeKey = {
  asset: (id: string) => `asset:${id}`,
  shot: (id: string) => `shot:${id}`,
  scene: (id: string) => `scene:${id}`,
  audio: (id: string) => `audio:${id}`,
} as const;

/**
 * Dependency graph of a VideoIR: shots depend on the format, the brand and the assets they show; scenes on
 * their shots (in order) and background; audio tracks on their asset. Timeline, captions and metadata are
 * one `document` node, so re-timing never invalidates shot content.
 */
export function videoIrNodes(ir: VideoIR): DependencyNode[] {
  const nodes: DependencyNode[] = [
    { key: "format", content: ir.format, dependsOn: [] },
    { key: "brand", content: ir.brand ?? null, dependsOn: [] },
    ...ir.assets.map((a) => ({ key: nodeKey.asset(a.id), content: a, dependsOn: [] })),
  ];
  for (const scene of ir.scenes) {
    for (const shot of scene.shots) {
      const assetId = "assetId" in shot ? shot.assetId : undefined;
      nodes.push({
        key: nodeKey.shot(shot.id),
        content: shot,
        dependsOn: ["format", "brand", ...(assetId ? [nodeKey.asset(assetId)] : [])],
      });
    }
    const { shots, ...own } = scene;
    nodes.push({
      key: nodeKey.scene(scene.id),
      content: { ...own, shotIds: shots.map((s) => s.id) },
      dependsOn: [
        "format",
        "brand",
        ...shots.map((s) => nodeKey.shot(s.id)),
        ...(scene.background?.assetId ? [nodeKey.asset(scene.background.assetId)] : []),
      ],
    });
  }
  for (const track of ir.audio ?? []) {
    nodes.push({ key: nodeKey.audio(track.id), content: track, dependsOn: [nodeKey.asset(track.assetId)] });
  }
  const { assets, scenes, audio, brand, format, ...document } = ir;
  nodes.push({
    key: "document",
    content: document,
    dependsOn: [...scenes.map((s) => nodeKey.scene(s.id)), ...(audio ?? []).map((t) => nodeKey.audio(t.id))],
  });
  return nodes;
}
