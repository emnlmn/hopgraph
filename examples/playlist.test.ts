// Runs the example and checks what it claims: one outcome per track and provider, the batches the
// artists table received, and a switched-off source reported as unread, never as empty.

import { describe, expect, it } from "vitest";
import { calls, example } from "./playlist.ts";

describe("examples/playlist", () => {
  it("answers every track with an outcome per provider", async () => {
    calls.length = 0;
    const result = await example();
    const outcome = (row: string, provider: string) =>
      result.rows.get(row)?.providers[provider]?.outcome;

    expect(result.status).toBe("complete");
    expect(result.rows.get("t1")?.providers.trackSummary?.rows[0]?.fields).toEqual({
      plays: 120,
      hit: true,
    });
    expect(result.rows.get("t2")?.providers.artistProfile?.rows[0]?.fields).toEqual({
      name: "Ode Ferris",
      country: "FR",
    });
    // t4's performer is not in the artists table; t5 is not in the tracks table
    expect(outcome("t4", "artistProfile")).toBe("absent");
    expect(outcome("t5", "trackSummary")).toBe("absent");
    expect(outcome("t5", "artistProfile")).toBe("absent");
    // the label service is switched off: unknown, with the reason
    expect(outcome("t1", "labelName")).toBe("unknown");
    expect(result.rows.get("t1")?.providers.labelName?.unknown).toEqual([
      { reason: "unread", why: "disabled", connectors: ["labelApi"] },
    ]);
  });

  it("reads each source once per key, in the loader's batches, and never the disabled one", async () => {
    calls.length = 0;
    await example();
    expect(calls).toEqual([
      { source: "tracks", keys: ["t1", "t2", "t3", "t4", "t5"] },
      { source: "artists", keys: ["a1", "a2"] },
      { source: "artists", keys: ["a9"] },
    ]);
  });
});
