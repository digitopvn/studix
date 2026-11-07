import { describe, expect, it } from "vitest";
import { parseJobListQuery } from "../src/api/job-list-params.ts";

const validation = (query: Record<string, string>) => {
  try {
    parseJobListQuery(query);
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return "accepted";
};

describe("GET /api/jobs params", () => {
  it("parses sort, filters and cursor into a repository query", () => {
    expect(
      parseJobListQuery({
        limit: "50",
        cursor: "WzUsImpvYl8xIl0",
        sort: "spentCents",
        order: "asc",
        status: "queued,running",
        kind: "video.create",
        stage: "voice,storyboard",
        id: " abc ",
        project: "prj",
        createdFrom: "2026-11-01T00:00:00.000Z",
        updatedTo: "2026-11-07T23:59:59.999+07:00",
        progressMin: "0.25",
        progressMax: "1",
        spentMin: "0",
        spentMax: "500",
      }),
    ).toEqual({
      limit: 50,
      cursor: "WzUsImpvYl8xIl0",
      sort: "spentCents",
      order: "asc",
      status: ["queued", "running"],
      kind: ["video.create"],
      stage: ["voice", "storyboard"],
      idContains: "abc",
      projectContains: "prj",
      createdFrom: new Date("2026-11-01T00:00:00.000Z"),
      updatedTo: new Date("2026-11-07T16:59:59.999Z"),
      progressMin: 0.25,
      progressMax: 1,
      spentMin: 0,
      spentMax: 500,
    });
  });

  it("accepts an empty query", () => {
    expect(parseJobListQuery({})).toEqual({ idContains: undefined, projectContains: undefined });
  });

  it("rejects anything outside the allowlist with VALIDATION", () => {
    const rejected: Array<Record<string, string>> = [
      { sort: "organization_id" },
      { sort: "createdAt; drop table jobs" },
      { order: "sideways" },
      { status: "queued,exploded" },
      { kind: "video create" },
      { unknown: "1" },
      { createdFrom: "yesterday" },
      { progressMax: "2" },
      { spentMin: "-1" },
      { spentMax: "1.5" },
      { cursor: "has spaces" },
      { limit: "1000" },
      { id: "" },
    ];
    for (const query of rejected) {
      expect(validation(query), JSON.stringify(query)).toBe("VALIDATION");
    }
  });
});
