import { describe, expect, it } from "vitest";
import { analyst, cells, freshApp, intern } from "./support.ts";

describe("t4 track page", () => {
  it("analytics fast: each track shows its title and stream count", async () => {
    const app = await freshApp();
    const rows = await app.renderPage(["t1", "t2", "t3"], analyst);
    expect(cells(rows)).toEqual([
      ["Glass Harbour", 120_000],
      ["Night Drive", 45_000],
      ["Low Tide", 9_800],
    ]);
  });

  it("a track analytics has no data for shows 'none'", async () => {
    const app = await freshApp();
    const rows = await app.renderPage(["t4", "t5"], analyst);
    expect(cells(rows)).toEqual([
      ["Paper Moons", "none"],
      ["Ferrous", 310],
    ]);
  });

  it("analytics slow (2 s): the page answers within 600 ms", async () => {
    const app = await freshApp();
    app.analyticsApi.delayMs = 2_000;
    const start = performance.now();
    await app.renderPage(["t1", "t2"], analyst);
    expect(performance.now() - start).toBeLessThan(600);
  });

  it("analytics slow: titles are shown and streams are 'late'", async () => {
    const app = await freshApp();
    app.analyticsApi.delayMs = 2_000;
    const rows = await app.renderPage(["t1", "t4"], analyst);
    expect(cells(rows)).toEqual([
      ["Glass Harbour", "late"],
      ["Paper Moons", "late"],
    ]);
  });

  it("a late answer is not remembered: the next page, analytics fast again, shows numbers", async () => {
    const app = await freshApp();
    app.analyticsApi.delayMs = 2_000;
    await app.renderPage(["t1"], analyst);
    app.analyticsApi.delayMs = 5;
    const rows = await app.renderPage(["t1"], analyst);
    expect(cells(rows)).toEqual([["Glass Harbour", 120_000]]);
  });

  it("a viewer without the analytics permission sees titles and 'forbidden'", async () => {
    const app = await freshApp();
    const rows = await app.renderPage(["t1", "t4"], intern);
    expect(cells(rows)).toEqual([
      ["Glass Harbour", "forbidden"],
      ["Paper Moons", "forbidden"],
    ]);
  });

  it("a viewer without the analytics permission never calls analytics", async () => {
    const app = await freshApp();
    await app.renderPage(["t1", "t2", "t4"], intern);
    expect(app.analyticsApi.calls).toEqual([]);
  });

  it("a permitted viewer's cached streams are never served to a viewer without permission", async () => {
    const app = await freshApp();
    const first = await app.renderPage(["t1", "t2"], analyst);
    expect(cells(first)).toEqual([
      ["Glass Harbour", 120_000],
      ["Night Drive", 45_000],
    ]);
    const second = await app.renderPage(["t1", "t2"], intern);
    expect(cells(second)).toEqual([
      ["Glass Harbour", "forbidden"],
      ["Night Drive", "forbidden"],
    ]);
  });

  it("a viewer without permission first does not keep a permitted viewer from the numbers", async () => {
    const app = await freshApp();
    await app.renderPage(["t1", "t2"], intern);
    const rows = await app.renderPage(["t1", "t2"], analyst);
    expect(cells(rows)).toEqual([
      ["Glass Harbour", 120_000],
      ["Night Drive", 45_000],
    ]);
  });
});
