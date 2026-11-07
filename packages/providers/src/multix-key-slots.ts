import { MULTIX_KEY_PROVIDERS } from "./multix-key-providers.generated.ts";

/** One key a workspace or the platform can store for multix: a required key row of a multix provider. */
export interface MultixKeySlot {
  /** The provider id for its first key, `<provider>-<key>` for each further one (cloudflare-api-token). */
  id: string;
  provider: string;
  name: string;
  /** The env name Studix stores and injects. */
  keyName: string;
  /** Other names multix accepts for the same key; read from the environment, never stored. */
  aliases: readonly string[];
}

const kebab = (name: string) => name.toLowerCase().replaceAll("_", "-");

/** Every key multix reads, in provider order. Derived from multix, so a new provider needs no code here. */
export const MULTIX_KEY_SLOTS: readonly MultixKeySlot[] = MULTIX_KEY_PROVIDERS.flatMap((provider) =>
  provider.keys.map(([keyName, ...aliases], i) => ({
    id: i === 0 ? provider.id : `${provider.id}-${kebab(keyName).replace(`${provider.id}-`, "")}`,
    provider: provider.id,
    name: provider.keys.length === 1 ? provider.name : `${provider.name} (${keyName})`,
    keyName,
    aliases,
  })),
);

/** Slot id to the env name Studix stores it under. */
export const MULTIX_KEY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  MULTIX_KEY_SLOTS.map((slot) => [slot.id, slot.keyName]),
);

/** Every env name multix reads a key from, aliases included: what may reach a multix child process. */
export const MULTIX_ENV_KEY_NAMES: readonly string[] = MULTIX_KEY_SLOTS.flatMap((slot) => [
  slot.keyName,
  ...slot.aliases,
]);

/** Which slots have a key, from the key names `multix check` found. */
export function keyReadiness(found: ReadonlySet<string>): Record<string, boolean> {
  return Object.fromEntries(
    MULTIX_KEY_SLOTS.map((slot) => [slot.id, [slot.keyName, ...slot.aliases].some((n) => found.has(n))]),
  );
}

/** Which providers can run: every key slot of the provider is ready. */
export function providerReadiness(slots: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const ready: Record<string, boolean> = {};
  for (const slot of MULTIX_KEY_SLOTS)
    ready[slot.provider] = (ready[slot.provider] ?? true) && Boolean(slots[slot.id]);
  return ready;
}
