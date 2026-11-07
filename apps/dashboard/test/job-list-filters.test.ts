import { describe, expect, it } from "vitest";
import {
  clearFilters,
  currentSort,
  dayToInstant,
  hasFilters,
  instantToDay,
  jobListQuery,
  toApiNumber,
  toDisplayNumber,
  toggleSort,
  withList,
} from "../src/pages/job-list-filters.ts";

const q = (s: string) => new URLSearchParams(s);

describe("jobs page URL state", () => {
  it("defaults to Created, newest first", () => {
    expect(currentSort(q(""))).toEqual({ sort: "createdAt", order: "desc" });
    expect(currentSort(q("sort=bogus&order=up"))).toEqual({ sort: "createdAt", order: "desc" });
  });

  it("toggles a header between ascending and descending", () => {
    const kindAsc = toggleSort(q(""), "kind");
    expect(kindAsc.toString()).toBe("sort=kind&order=asc");
    expect(toggleSort(kindAsc, "kind").toString()).toBe("sort=kind&order=desc");
    const createdAsc = toggleSort(q(""), "createdAt");
    expect(createdAsc.toString()).toBe("sort=createdAt&order=asc");
    // Back to the default sort leaves the URL clean.
    expect(toggleSort(createdAsc, "createdAt").toString()).toBe("");
  });

  it("keeps only known params and clears filters but not the sort", () => {
    const query = jobListQuery(q("status=queued&evil=1&sort=kind&order=asc&project="));
    expect(query.toString()).toBe("sort=kind&order=asc&status=queued");
    expect(hasFilters(query)).toBe(true);
    expect(clearFilters(query).toString()).toBe("sort=kind&order=asc");
    expect(hasFilters(clearFilters(query))).toBe(false);
    expect(withList(query, "status", []).has("status")).toBe(false);
  });

  it("converts date and number inputs to API units and back", () => {
    const from = dayToInstant("2026-11-07", "from")!;
    const to = dayToInstant("2026-11-07", "to")!;
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(86_400_000 - 1);
    expect(instantToDay(from)).toBe("2026-11-07");
    expect(dayToInstant("", "from")).toBeUndefined();
    expect(toApiNumber("25", 100, false)).toBe("0.25");
    expect(toDisplayNumber("0.25", 100, false)).toBe("25");
    expect(toApiNumber("1.5", 100, true)).toBe("150");
    expect(toDisplayNumber("150", 100, true)).toBe("1.5");
    expect(toApiNumber("-3", 100, true)).toBeUndefined();
  });
});
