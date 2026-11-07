import { createSpawnMultixRunner, type MultixRunner, parseMultixEnvelope } from "./multix-cli-runner.ts";
import { MULTIX_ROLE_VENDORS, type MultixModelDefaults, type MultixRole } from "./multix-routes.ts";

/** One model a role can be set to, as `<vendor>:<model>`. */
export interface MultixCatalogEntry {
  id: string;
  vendor: string;
  model: string;
  label?: string;
  /** Modes or capabilities the catalogue states (text-to-video, image-edit, ...). */
  capabilities?: string[];
}

export interface MultixCatalog {
  roles: Record<MultixRole, MultixCatalogEntry[]>;
  /** Vendors whose role accepts any model id of theirs (Atlas): the list is a hint, not the whole set. */
  openVendors: string[];
  fetchedAt: string;
  /** Why a part of the catalogue could not be read; the rest is still served. */
  errors: string[];
}

/** A row of `multix models --json` (multix.capability rows); only the fields read here. */
interface ModelRow {
  task?: string;
  provider?: string;
  default_model?: string;
  models?: string[];
  any_model?: boolean;
}

/** A model of `multix sume models --json` (Sume's public catalogue). */
interface SumeModel {
  id?: string;
  kind?: string;
  name?: string;
  modes?: string[];
  capabilities?: { routes?: string[] };
}

const ROLE_TASKS: Partial<Record<MultixRole, string>> = { voice: "speech", music: "music", sfx: "sfx" };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** The Sume roles a catalogue model serves: lip-sync by kind, upscale and restyle as video-to-video. */
function sumeRoles(model: SumeModel): MultixRole[] {
  // Models on a special route cannot be driven through `multix sume video`.
  if ((model.capabilities?.routes ?? []).length > 0) return [];
  const modes = model.modes ?? [];
  switch (model.kind) {
    case "image":
      return ["image"];
    case "lipsync":
      return ["lipsync"];
    case "video": {
      const roles: MultixRole[] = [];
      if (modes.some((m) => m === "text-to-video" || m === "image-to-video")) roles.push("video");
      if (modes.includes("video-to-video")) roles.push("videoUpscale");
      return roles;
    }
    default:
      return [];
  }
}

/**
 * Group the multix catalogues by Studix media role. Only vendors the role runs on are kept, and each role's
 * server default is listed even when no catalogue names it.
 */
export function buildMultixCatalog(
  input: { models?: unknown; sume?: unknown; defaults: MultixModelDefaults; errors?: string[] },
  now: Date = new Date(),
): MultixCatalog {
  const roles = Object.fromEntries(
    Object.keys(MULTIX_ROLE_VENDORS).map((role) => [role, [] as MultixCatalogEntry[]]),
  ) as Record<MultixRole, MultixCatalogEntry[]>;
  const add = (role: MultixRole, entry: Omit<MultixCatalogEntry, "id">) => {
    if (!(MULTIX_ROLE_VENDORS[role] as readonly string[]).includes(entry.vendor)) return;
    if (!MODEL_ID.test(entry.model)) return;
    const id = `${entry.vendor}:${entry.model}`;
    if (roles[role].some((e) => e.id === id)) return;
    roles[role].push({ id, ...entry });
  };
  const openVendors = new Set<string>();

  for (const role of Object.keys(roles) as MultixRole[]) {
    const id = input.defaults[role];
    const sep = id.indexOf(":");
    if (sep > 0) add(role, { vendor: id.slice(0, sep), model: id.slice(sep + 1), label: "Server default" });
  }
  for (const model of asArray<SumeModel>((input.sume as { models?: unknown } | undefined)?.models)) {
    if (typeof model.id !== "string") continue;
    for (const role of sumeRoles(model)) {
      add(role, {
        vendor: "sume",
        model: model.id,
        ...(model.name ? { label: model.name } : {}),
        ...(model.modes?.length ? { capabilities: model.modes } : {}),
      });
    }
  }
  for (const row of asArray<ModelRow>(input.models)) {
    for (const [role, task] of Object.entries(ROLE_TASKS) as [MultixRole, string][]) {
      if (row.task !== task || typeof row.provider !== "string") continue;
      if (!(MULTIX_ROLE_VENDORS[role] as readonly string[]).includes(row.provider)) continue;
      if (row.any_model) openVendors.add(row.provider);
      const ids = [...(row.default_model ? [row.default_model] : []), ...(row.models ?? [])];
      // Wildcards ("veo-*") name a family, not a model id.
      for (const model of ids) if (!model.includes("*")) add(role, { vendor: row.provider, model });
    }
  }
  // Image upscale runs any Atlas model id; multix lists none of them.
  for (const vendor of MULTIX_ROLE_VENDORS.imageUpscale) openVendors.add(vendor);
  return {
    roles,
    openVendors: [...openVendors].sort(),
    fetchedAt: now.toISOString(),
    errors: input.errors ?? [],
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as T[]) : [];
}

export interface MultixCatalogLoaderOptions {
  bin: string | undefined;
  defaults: MultixModelDefaults;
  env?: Readonly<Record<string, string | undefined>>;
  runner?: MultixRunner;
  /** How long a loaded catalogue is served before multix is asked again. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 30_000;

/**
 * Read the catalogue from the multix CLI and keep it for a short while. Both commands are free: `models`
 * reads multix's own tables and `sume models` Sume's public catalogue (no key, cached by multix too).
 */
export function createMultixCatalogLoader(options: MultixCatalogLoaderOptions): () => Promise<MultixCatalog> {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  let cached: { at: number; value: Promise<MultixCatalog> } | undefined;

  async function load(): Promise<MultixCatalog> {
    const bin = options.bin?.trim();
    if (!bin) return buildMultixCatalog({ defaults: options.defaults, errors: ["Multix is not installed"] });
    const runner = options.runner ?? createSpawnMultixRunner(bin);
    const childEnv: Record<string, string> = { MULTIX_DISABLE_HOME_ENV: "1" };
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"]) {
      const value = env[name];
      if (value) childEnv[name] = value;
    }
    const errors: string[] = [];
    const read = async (argv: string[]) => {
      try {
        const run = await runner([...argv, "--json"], {
          cwd: process.cwd(),
          env: childEnv,
          timeoutMs: CATALOG_TIMEOUT_MS,
        });
        const envelope = parseMultixEnvelope(run.stdout);
        if (run.exitCode === 0 && envelope?.ok) return envelope.data;
        errors.push(`multix ${argv.join(" ")} failed`);
      } catch {
        errors.push(`multix ${argv.join(" ")} could not start`);
      }
      return undefined;
    };
    const [models, sume] = await Promise.all([read(["models"]), read(["sume", "models"])]);
    return buildMultixCatalog({ models, sume, defaults: options.defaults, errors }, new Date(now()));
  }

  return () => {
    const at = now();
    if (!cached || at - cached.at >= ttl) {
      const value = load();
      cached = { at, value };
      // A failed read is not kept, so the next request asks again.
      value.then(
        (c) => {
          if (c.errors.length > 0 && cached?.value === value) cached = undefined;
        },
        () => {
          if (cached?.value === value) cached = undefined;
        },
      );
    }
    return cached.value;
  };
}
