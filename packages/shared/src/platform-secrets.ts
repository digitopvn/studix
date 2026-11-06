/**
 * The only platform credentials an operator can store from the dashboard. A name outside this list is
 * rejected everywhere (API, repository reads, the environment handed to Multix), so the dashboard is never
 * an arbitrary environment editor.
 */
export interface PlatformSecretSpec {
  /** Row name; for media keys it is also the environment variable the Multix CLI reads. */
  name: string;
  group: "storage" | "media";
  label: string;
  /** Media vendor id as used by the Multix routes; absent for storage. */
  vendor?: string;
  /** Media kinds this key unlocks, for the dashboard table. */
  kinds?: readonly string[];
}

/** One row holds the pair, so a replacement is atomic and a key id can never meet the wrong secret. */
export const STORAGE_CREDENTIALS_NAME = "S3_CREDENTIALS";

export const PLATFORM_SECRET_SPECS: readonly PlatformSecretSpec[] = [
  { name: STORAGE_CREDENTIALS_NAME, group: "storage", label: "Object storage (Cloudflare R2) access key" },
  {
    name: "SUME_API_KEY",
    group: "media",
    label: "Sume",
    vendor: "sume",
    kinds: ["image", "video", "lip-sync", "video upscale"],
  },
  {
    name: "ATLASCLOUD_API_KEY",
    group: "media",
    label: "Atlas Cloud",
    vendor: "atlas",
    kinds: ["image upscale"],
  },
  {
    name: "ELEVENLABS_API_KEY",
    group: "media",
    label: "ElevenLabs",
    vendor: "elevenlabs",
    kinds: ["voice", "music", "sound effects"],
  },
  { name: "FISH_API_KEY", group: "media", label: "Fish Audio", vendor: "fish", kinds: ["voice"] },
  { name: "MINIMAX_API_KEY", group: "media", label: "MiniMax", vendor: "minimax", kinds: ["voice", "music"] },
  { name: "OPENROUTER_API_KEY", group: "media", label: "OpenRouter", vendor: "openrouter", kinds: ["voice"] },
];

const BY_NAME = new Map(PLATFORM_SECRET_SPECS.map((spec) => [spec.name, spec]));

export function platformSecretSpec(name: string): PlatformSecretSpec | undefined {
  return BY_NAME.get(name);
}

/** Environment variables of the media keys, the only secrets ever placed in a Multix child environment. */
export const PLATFORM_MEDIA_ENV_NAMES: readonly string[] = PLATFORM_SECRET_SPECS.filter(
  (spec) => spec.group === "media",
).map((spec) => spec.name);

/** Sealed value of the storage row: the pair, as JSON. */
export interface StorageCredentialPair {
  accessKeyId: string;
  secretAccessKey: string;
}
