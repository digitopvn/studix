import type { MultixCatalogEntry } from "../api-client.ts";

/** One row of a role's model list; `value: ""` is the "use the server value" row. */
export interface ModelOption {
  value: string;
  label?: string;
  capabilities?: string[];
  needsKey?: boolean;
}

/**
 * The options a role's model picker shows for `query`: the server-value row, the catalogue models that match
 * (by id, label or capability, every word of the query) and, first, the current value when the catalogue
 * does not list it, so a saved custom model stays visible.
 */
export function modelOptions(
  entries: readonly MultixCatalogEntry[],
  query: string,
  current: string,
): ModelOption[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const listed = entries
    .filter((e) => matches([e.id, e.label ?? "", ...(e.capabilities ?? [])].join(" ")))
    .map((e) => ({
      value: e.id,
      ...(e.label ? { label: e.label } : {}),
      ...(e.capabilities ? { capabilities: e.capabilities } : {}),
      ...(e.needsKey ? { needsKey: true } : {}),
    }));
  const extra =
    current !== "" && !entries.some((e) => e.id === current) && matches(current) ? [{ value: current }] : [];
  return [...(words.length === 0 ? [{ value: "" }] : []), ...extra, ...listed];
}

/** Why a typed model may not run, or undefined when the catalogue lists it (custom values stay allowed). */
export function modelWarning(
  value: string,
  entries: readonly MultixCatalogEntry[],
  openVendors: readonly string[],
): string | undefined {
  const id = value.trim();
  const entry = entries.find((e) => e.id === id);
  if (entry?.needsKey)
    return `Needs a ${entry.vendor} key: add one under Media vendor keys before a job uses it.`;
  if (id === "" || entry) return undefined;
  const vendor = id.includes(":") ? id.slice(0, id.indexOf(":")) : "";
  if (openVendors.includes(vendor))
    return `Not in the Multix catalogue; ${vendor} accepts any of its model ids.`;
  return "Not in the Multix catalogue for this role; Save checks it, and a job may fail if the model is unknown.";
}
