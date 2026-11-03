import { checkGraph, type GraphDef } from "hopgraph";
import { describe, expect, it } from "vitest";
import { freshApp, provider } from "./support.ts";

const LABEL = "labelInfo";

describe("t1 labelInfo", () => {
  it("finds a track's label through its artist, with name and country", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t1", "t2"], [LABEL]);
    const t1 = provider(result, "t1", LABEL);
    expect(t1.outcome).toBe("found");
    expect(t1.rows).toHaveLength(1);
    expect(t1.rows[0]?.fields).toMatchObject({ name: "Hollowreed Records", country: "IT" });
    expect(provider(result, "t2", LABEL).rows[0]?.fields).toMatchObject({
      name: "Saltmarsh Sound",
      country: "FR",
    });
  });

  it("an unsigned artist's track has labelInfo absent", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t3"], [LABEL]);
    expect(provider(result, "t3", LABEL).outcome).toBe("absent");
  });

  it("a label id the labels service does not know is absent", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t4"], [LABEL]);
    expect(provider(result, "t4", LABEL).outcome).toBe("absent");
  });

  it("labels service down: labelInfo is unknown with reason failed, not absent", async () => {
    const app = await freshApp();
    app.labelsApi.fail = true;
    const result = await app.read("track", ["t1", "t2"], [LABEL]);
    for (const id of ["t1", "t2"]) {
      const p = provider(result, id, LABEL);
      expect(p.outcome).toBe("unknown");
      expect(p.unknown.map((u) => u.reason)).toContain("failed");
    }
  });

  it("labels service down: artistProfile is still found", async () => {
    const app = await freshApp();
    app.labelsApi.fail = true;
    const result = await app.read("track", ["t1"], ["artistProfile", LABEL]);
    const profile = provider(result, "t1", "artistProfile");
    expect(profile.outcome).toBe("found");
    expect(profile.rows[0]?.fields).toEqual({ name: "Mira Volk", country: "IT" });
  });

  it("a failure is not remembered: once the service is back the label is found", async () => {
    const app = await freshApp();
    app.labelsApi.fail = true;
    await app.read("track", ["t1"], [LABEL]);
    app.labelsApi.fail = false;
    const result = await app.read("track", ["t1"], [LABEL]);
    expect(provider(result, "t1", LABEL).outcome).toBe("found");
  });

  it("30 tracks call the labels service once", async () => {
    const app = await freshApp();
    const ids = Array.from({ length: 30 }, (_, i) => `c${i + 1}`);
    const result = await app.read("track", ids, [LABEL]);
    for (const id of ids) expect(provider(result, id, LABEL).outcome).toBe("found");
    expect(app.labelsApi.calls).toHaveLength(1);
  });

  it("a second read of the same tracks is served without calling the labels service", async () => {
    const app = await freshApp();
    await app.read("track", ["t1", "t2"], [LABEL]);
    const calls = app.labelsApi.calls.length;
    const result = await app.read("track", ["t1", "t2"], [LABEL]);
    expect(provider(result, "t1", LABEL).outcome).toBe("found");
    expect(app.labelsApi.calls.length).toBe(calls);
  });

  it("checkGraph from track reports no problem", async () => {
    const app = await freshApp();
    const check = checkGraph(app.graph as GraphDef<unknown>, { bases: ["track"] });
    expect(check.problems).toEqual([]);
  });

  it("artistProfile and trackInfo are unchanged", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t1", "t3", "t404"], ["trackInfo", "artistProfile"]);
    expect(provider(result, "t1", "trackInfo").rows[0]?.fields).toEqual({ title: "Glass Harbour" });
    expect(provider(result, "t1", "artistProfile").rows[0]?.fields).toEqual({
      name: "Mira Volk",
      country: "IT",
    });
    expect(provider(result, "t3", "artistProfile").rows[0]?.fields).toEqual({
      name: "Kit Lune",
      country: "SE",
    });
    expect(provider(result, "t404", "artistProfile").outcome).toBe("absent");
  });
});
