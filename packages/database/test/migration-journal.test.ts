import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(
  readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: JournalEntry[] };

describe("migration journal", () => {
  // The migrator applies only migrations journaled after the newest one a database recorded, so an entry
  // timestamped before its predecessor is skipped forever on a database that already ran that predecessor.
  it("journals every migration later than the one before it", () => {
    const outOfOrder = journal.entries
      .slice(1)
      .filter((entry, i) => entry.when <= (journal.entries[i] as JournalEntry).when)
      .map((entry) => entry.tag);
    // 0013 shipped out of order and cannot be re-timed without reapplying it; 0015 repairs databases that skipped it.
    expect(outOfOrder).toEqual(["0013_job_deadline_window"]);
  });

  it("numbers entries in order", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });
});
