// Loose views of the app's modules: the hidden tests compile against any solution's types, so a
// type error in a run is always the solution's own.
import { vi } from "vitest";

export interface User {
  id: string;
  permissions: string[];
}
export interface Row {
  track?: string;
  title: string;
  streams: number | string;
}
export interface App {
  renderPage(trackIds: string[], user: User): Promise<Row[]>;
  analyticsApi: { delayMs: number; calls: string[][] };
}

/** A fresh copy of the app (its runner, shared cache and fakes), as a new process would have it. */
export async function freshApp(): Promise<App> {
  vi.resetModules();
  const pageModule: Record<string, unknown> = await import("../../src/page.ts");
  const analyticsModule: Record<string, unknown> = await import("../../src/sources/analytics.ts");
  return {
    renderPage: pageModule.renderPage as App["renderPage"],
    analyticsApi: analyticsModule.analyticsApi as App["analyticsApi"],
  };
}

export const analyst: User = { id: "u-ana", permissions: ["catalog", "analytics"] };
export const intern: User = { id: "u-int", permissions: ["catalog"] };

/** [title, streams] per row, in order. */
export const cells = (rows: Row[]) => rows.map((r) => [r.title, r.streams]);
