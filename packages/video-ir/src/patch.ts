import { StudixError } from "@studix/shared";
import { z } from "zod";
import { validateVideoIR } from "./validate.ts";
import { safeValidate, unwrapValidation } from "./validation-result.ts";
import type { VideoIR } from "./video-ir.ts";

/** RFC 6901 JSON pointer; "" addresses the whole document and is not patchable. */
const Pointer = z.string().regex(/^(\/[^/]*)+$/, "expected a JSON pointer such as /scenes/0/durationMs");

/** Subset of RFC 6902 JSON Patch used for immutable IR revisions. */
export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: Pointer, value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: Pointer }),
  z.object({ op: z.literal("replace"), path: Pointer, value: z.unknown() }),
  z.object({ op: z.literal("move"), from: Pointer, path: Pointer }),
  z.object({ op: z.literal("copy"), from: Pointer, path: Pointer }),
  z.object({ op: z.literal("test"), path: Pointer, value: z.unknown() }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

export const VideoIRPatch = z.object({
  /** Why the change was made (shown in version history). */
  description: z.string().max(500).optional(),
  ops: z.array(PatchOp).min(1).max(500),
});
export type VideoIRPatch = z.infer<typeof VideoIRPatch>;

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

type Container = Record<string, unknown> | unknown[];

function parsePointer(pointer: string): string[] {
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) throw patchError(`forbidden path segment "${segment}"`, pointer);
  }
  return segments;
}

function patchError(
  message: string,
  path: string,
  code: "VALIDATION" | "CONFLICT" = "VALIDATION",
): StudixError {
  return new StudixError(code, `Patch failed at ${path}: ${message}`, {
    details: { path },
    suggestedAction:
      code === "CONFLICT" ? "Reload the latest version and rebuild the patch." : "Fix the patch op.",
  });
}

function isContainer(value: unknown): value is Container {
  return value !== null && typeof value === "object";
}

function arrayIndex(arr: unknown[], segment: string, path: string, allowEnd: boolean): number {
  if (allowEnd && segment === "-") return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(segment)) throw patchError(`"${segment}" is not an array index`, path);
  const index = Number(segment);
  if (index > arr.length || (!allowEnd && index === arr.length)) throw patchError("index out of range", path);
  return index;
}

/** Resolve the parent container and final key of a pointer. */
function locate(doc: Container, pointer: string): { parent: Container; key: string } {
  const segments = parsePointer(pointer);
  let current: unknown = doc;
  for (const segment of segments.slice(0, -1)) {
    if (!isContainer(current)) throw patchError("path does not exist", pointer);
    current = Array.isArray(current)
      ? current[arrayIndex(current, segment, pointer, false)]
      : Object.hasOwn(current, segment)
        ? current[segment]
        : undefined;
  }
  if (!isContainer(current)) throw patchError("path does not exist", pointer);
  return { parent: current, key: segments[segments.length - 1]! };
}

function read(doc: Container, pointer: string): unknown {
  const { parent, key } = locate(doc, pointer);
  if (Array.isArray(parent)) return parent[arrayIndex(parent, key, pointer, false)];
  if (!Object.hasOwn(parent, key)) throw patchError("path does not exist", pointer);
  return parent[key];
}

function add(doc: Container, pointer: string, value: unknown): void {
  const { parent, key } = locate(doc, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, pointer, true), 0, value);
  else parent[key] = value;
}

function remove(doc: Container, pointer: string): unknown {
  const { parent, key } = locate(doc, pointer);
  if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, pointer, false), 1)[0];
  if (!Object.hasOwn(parent, key)) throw patchError("path does not exist", pointer);
  const old = parent[key];
  delete parent[key];
  return old;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => deepEqual((a as never)[k], (b as never)[k]));
}

/** Apply ops to an arbitrary JSON document copy. The input is never mutated. */
export function applyJsonPatch<T>(document: T, ops: ReadonlyArray<PatchOp>): unknown {
  const doc = structuredClone(document) as unknown;
  if (!isContainer(doc)) throw patchError("document is not an object", "");
  for (const op of ops) {
    switch (op.op) {
      case "add":
        add(doc, op.path, structuredClone(op.value));
        break;
      case "remove":
        remove(doc, op.path);
        break;
      case "replace":
        read(doc, op.path);
        remove(doc, op.path);
        add(doc, op.path, structuredClone(op.value));
        break;
      case "move": {
        if (op.path.startsWith(`${op.from}/`)) throw patchError("cannot move a value into itself", op.path);
        add(doc, op.path, remove(doc, op.from));
        break;
      }
      case "copy":
        add(doc, op.path, structuredClone(read(doc, op.from)));
        break;
      case "test":
        if (!deepEqual(read(doc, op.path), op.value))
          throw patchError("test op did not match", op.path, "CONFLICT");
        break;
    }
  }
  return doc;
}

/**
 * Produce the next immutable IR revision. The patch is validated, applied to a deep copy, and the
 * result must pass validateVideoIR; otherwise a VALIDATION (or CONFLICT for failed `test` ops) error is
 * thrown and the input is left untouched.
 */
export function applyPatch(ir: VideoIR, patch: VideoIRPatch): VideoIR {
  const valid = unwrapValidation(safeValidate(VideoIRPatch, patch), "VideoIR patch");
  const next = applyJsonPatch(ir, valid.ops);
  return unwrapValidation(validateVideoIR(next), "patched VideoIR");
}
