import { describe, expect, it } from "vitest";
import { artistProfile, trackInfo } from "../src/graph.ts";
import { runner } from "../src/runner.ts";

describe("track page", () => {
  it("shows the track's title and its performer's profile", async () => {
    const result = await runner.read("track", ["t1", "t2"], [trackInfo, artistProfile]);
    const t1 = result.rows.get("t1")?.providers;
    expect(t1?.trackInfo.rows[0]?.fields.title).toBe("Glass Harbour");
    expect(t1?.artistProfile.outcome).toBe("found");
    expect(t1?.artistProfile.rows[0]?.fields).toEqual({ name: "Mira Volk", country: "IT" });
    expect(result.rows.get("t2")?.providers.artistProfile.rows[0]?.fields.name).toBe("Ode Ferris");
  });

  it("says absent for a track the catalog does not have", async () => {
    const result = await runner.read("track", ["t404"], [trackInfo, artistProfile]);
    expect(result.rows.get("t404")?.providers.trackInfo.outcome).toBe("absent");
    expect(result.rows.get("t404")?.providers.artistProfile.outcome).toBe("absent");
  });
});
