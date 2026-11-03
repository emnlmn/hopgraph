import { describe, expect, it } from "vitest";
import { trackStreams, trackSummary } from "../src/graph.ts";
import { runner } from "../src/runner.ts";

describe("track page graph", () => {
  it("reads titles and stream counts", async () => {
    const result = await runner.read("track", ["t1", "t2"], [trackSummary, trackStreams]);
    const t1 = result.rows.get("t1")?.providers;
    expect(t1?.trackSummary.rows[0]?.fields.title).toBe("Glass Harbour");
    expect(t1?.trackStreams.rows[0]?.fields.streams).toBe(120_000);
  });
});
