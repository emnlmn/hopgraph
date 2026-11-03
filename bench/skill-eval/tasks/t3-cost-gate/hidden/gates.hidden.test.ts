import { describe, expect, it } from "vitest";
import { approveAll, freshApp, GB, MB, stat, tracks } from "./support.ts";

const PER_TRACK = { streams: 100 * MB, skips: 10 * MB } as Record<string, number>;

describe("t3 cost gate", () => {
  it("under 1 GB (5 tracks): done at once, values found, billed 550 MB", async () => {
    const app = await freshApp();
    const answer = await app.streamsFor(tracks(5));
    expect(answer.status).toBe("done");
    expect(stat(answer, "t001").streams).toEqual({ outcome: "found", value: 1000 });
    expect(stat(answer, "t005").skipRate).toEqual({ outcome: "found", value: 0.5 });
    expect(app.warehouse.billed).toBe(550 * MB);
  });

  it("every warehouse query is given a byte limit no higher than its price", async () => {
    const app = await freshApp();
    await app.streamsFor(tracks(5));
    expect(app.warehouse.queries.length).toBeGreaterThan(0);
    for (const q of app.warehouse.queries) {
      expect(q.maxBytes).toBeDefined();
      expect(q.maxBytes).toBeLessThanOrEqual(q.tracks * (PER_TRACK[q.table] ?? 0));
    }
  });

  it("over 1 GB (20 tracks, 2 GB of streams): needs approval with one 2 GB gate", async () => {
    const app = await freshApp();
    const answer = await app.streamsFor(tracks(20));
    expect(answer.status).toBe("needs-approval");
    expect(answer.gates?.map((g) => g.bytes)).toEqual([2 * GB]);
    expect(typeof answer.resume).toBe("function");
  });

  it("while awaiting approval, streams are unknown (awaiting_approval) and not billed", async () => {
    const app = await freshApp();
    const answer = await app.streamsFor(tracks(20));
    expect(stat(answer, "t001").streams).toEqual({ outcome: "unknown", reason: "awaiting_approval" });
    expect(app.warehouse.queries.filter((q) => q.table === "streams")).toEqual([]);
    // what needs no approval is read meanwhile
    expect(stat(answer, "t001").title).toBe("Track 1");
    expect(stat(answer, "t001").skipRate).toEqual({ outcome: "found", value: 0.1 });
  });

  it("resume with the gate approved: done, streams found, never-streamed tracks absent", async () => {
    const app = await freshApp();
    const first = await app.streamsFor(tracks(20));
    const second = await first.resume!(approveAll(first));
    expect(second.status).toBe("done");
    expect(stat(second, "t020").streams).toEqual({ outcome: "found", value: 20_000 });
    expect(stat(second, "t007").streams).toEqual({ outcome: "absent" });
    expect(stat(second, "t014").streams).toEqual({ outcome: "absent" });
  });

  it("resume does not bill again what the first round read: 2.2 GB in total", async () => {
    const app = await freshApp();
    const first = await app.streamsFor(tracks(20));
    await first.resume!(approveAll(first));
    expect(app.warehouse.billed).toBe(2 * GB + 200 * MB);
  });

  it("resume does not price the warehouse again: two dry runs in total", async () => {
    const app = await freshApp();
    const first = await app.streamsFor(tracks(20));
    await first.resume!(approveAll(first));
    expect(app.warehouse.dryRuns).toHaveLength(2);
  });

  it("each table is read in one query for 20 tracks", async () => {
    const app = await freshApp();
    const first = await app.streamsFor(tracks(20));
    await first.resume!(approveAll(first));
    expect(app.warehouse.queries.filter((q) => q.table === "streams")).toHaveLength(1);
    expect(app.warehouse.queries.filter((q) => q.table === "skips")).toHaveLength(1);
  });

  it("approvals passed to streamsFor up front run the gated read", async () => {
    const app = await freshApp();
    const first = await app.streamsFor(tracks(20));
    const again = await app.streamsFor(tracks(20), approveAll(first));
    expect(again.status).toBe("done");
    expect(stat(again, "t001").streams).toEqual({ outcome: "found", value: 1000 });
  });

  it("over 50 GB (600 tracks): streams refused as too_heavy, never billed or offered for approval", async () => {
    const app = await freshApp();
    const answer = await app.streamsFor(tracks(600));
    expect(stat(answer, "t001").streams).toEqual({ outcome: "unknown", reason: "too_heavy" });
    expect(app.warehouse.queries.filter((q) => q.table === "streams")).toEqual([]);
    expect(app.warehouse.billed).toBe(0);
    expect((answer.gates ?? []).some((g) => g.bytes === 60 * GB)).toBe(false);
  });
});
