import { describe, expect, it } from "vitest";
import { freshApp, provider } from "./support.ts";

const P = "artistProfile";

describe("t2 outcomes", () => {
  it("a current track's artist is found", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t1"], [P]);
    expect(provider(result, "t1", P).outcome).toBe("found");
    expect(provider(result, "t1", P).rows[0]?.fields).toEqual({ name: "Mira Volk", country: "IT" });
  });

  it("an artist removed from the catalog is absent, not unknown", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t7"], [P]);
    expect(provider(result, "t7", P).outcome).toBe("absent");
  });

  it("an artist removed from the catalog shows 'no profile'", async () => {
    const app = await freshApp();
    const [box] = await app.artistBoxes(["t7"]);
    expect(box?.label).toBe("no profile");
  });

  it("database down: artistProfile is unknown with reason failed, not absent", async () => {
    const app = await freshApp();
    app.db.down = true;
    const result = await app.read("track", ["t1", "t7"], [P]);
    for (const id of ["t1", "t7"]) {
      const p = provider(result, id, P);
      expect(p.outcome).toBe("unknown");
      expect(p.unknown.map((u) => u.reason)).toContain("failed");
    }
  });

  it("database down: the page shows 'profile unavailable', never 'no profile'", async () => {
    const app = await freshApp();
    app.db.down = true;
    const boxes = await app.artistBoxes(["t1", "t3", "t7"]);
    expect(boxes.map((b) => b.label)).toEqual([
      "profile unavailable",
      "profile unavailable",
      "profile unavailable",
    ]);
  });

  it("database back up: the next page shows the profiles again", async () => {
    const app = await freshApp();
    app.db.down = true;
    await app.artistBoxes(["t1", "t2"]);
    app.db.down = false;
    const boxes = await app.artistBoxes(["t1", "t2"]);
    expect(boxes.map((b) => [b.label, b.artist])).toEqual([
      ["profile", "Mira Volk"],
      ["profile", "Ode Ferris"],
    ]);
  });

  it("a 2019-imported track with a numeric artist id finds its artist", async () => {
    const app = await freshApp();
    const result = await app.read("track", ["t3", "t4"], [P]);
    expect(provider(result, "t3", P).outcome).toBe("found");
    expect(provider(result, "t3", P).rows[0]?.fields).toEqual({ name: "Kit Lune", country: "SE" });
    expect(provider(result, "t4", P).rows[0]?.fields).toEqual({ name: "Ode Ferris", country: "FR" });
  });

  it("a 2019-imported track shows 'profile' with its artist's name", async () => {
    const app = await freshApp();
    const [box] = await app.artistBoxes(["t3"]);
    expect(box).toMatchObject({ track: "t3", title: "Low Tide", label: "profile", artist: "Kit Lune" });
  });

  it("a 2019-imported track whose artist was removed shows 'no profile'", async () => {
    const app = await freshApp();
    const [box] = await app.artistBoxes(["t8"]);
    expect(box?.label).toBe("no profile");
  });

  it("a page of mixed tracks gives each its own text", async () => {
    const app = await freshApp();
    const boxes = await app.artistBoxes(["t1", "t3", "t7", "t8", "t404", "t2"]);
    expect(boxes.map((b) => [b.track, b.label])).toEqual([
      ["t1", "profile"],
      ["t3", "profile"],
      ["t7", "no profile"],
      ["t8", "no profile"],
      ["t404", "no profile"],
      ["t2", "profile"],
    ]);
  });

  it("a page reads the artists table in one query", async () => {
    const app = await freshApp();
    await app.artistBoxes(["t1", "t2", "t3", "t4", "t5", "t7", "t8"]);
    expect(app.db.calls.filter((c) => c.table === "artists")).toHaveLength(1);
  });

  it("profileLabel still maps found, absent and unknown to the three texts", async () => {
    const app = await freshApp();
    expect(app.profileLabel("found")).toBe("profile");
    expect(app.profileLabel("absent")).toBe("no profile");
    expect(app.profileLabel("unknown")).toBe("profile unavailable");
  });
});
