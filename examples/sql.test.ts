// Runs the SQL-like example and checks what it claims: statements of two windows in key order, a
// window per pitch, the cap inside the statement reported as a cut, and a failed statement that
// leaves its keys unknown while the others stand.

import { describe, expect, it } from "vitest";
import { broken, example, statements } from "./sql.ts";

describe("examples/sql", () => {
  it("reads each pitch's window, caps it inside the statement, and keeps a failed statement's keys unknown", async () => {
    statements.length = 0;
    broken.clear();
    broken.add("a3");
    const result = await example();
    const p = (pitch: string) => result.rows.get(pitch)?.providers.tracksBefore;

    // p1: four tracks in the window, three read, cut
    expect(p("p1")?.rows.map((r) => r.fields.track)).toEqual(["t4", "t3", "t2"]);
    expect(p("p1")?.cut).toEqual([{ kind: "cap", limit: 3 }]);
    expect(p("p1")?.outcome).toBe("found");
    // p2: the same artist, its own window
    expect(p("p2")?.rows.map((r) => r.fields.track)).toEqual(["t2", "t1"]);
    expect(p("p2")?.cut).toEqual([]);
    // p3: nothing in its window: absent, with what was searched
    expect(p("p3")?.outcome).toBe("absent");
    expect(p("p3")?.coverage).toEqual([{ label: "30 days before", days: 30 }]);
    // p4: its statement failed: unknown, never absent
    expect(p("p4")?.outcome).toBe("unknown");
    expect(p("p4")?.unknown).toEqual([{ reason: "failed" }]);
    const trace = result.trace.find((t) => t.loader === "recentTracks");
    expect(trace?.errors).toEqual([{ code: "57014", keys: 1 }]);
  });

  it("sends statements of at most two windows, a key with two windows in two of them", async () => {
    statements.length = 0;
    broken.clear();
    await example();

    expect(statements.map((s) => s.split(" -- ")[1])).toEqual([
      "a1@2026-10-12, a2@2026-10-30",
      "a3@2026-10-30",
      "a1@2026-10-30",
    ]);
  });
});
