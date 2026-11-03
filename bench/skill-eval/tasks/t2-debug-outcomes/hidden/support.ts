// Loose views of the app's modules: the hidden tests compile against any solution's types, so a
// type error in a run is always the solution's own.
import { vi } from "vitest";

export interface ProviderView {
  outcome: "found" | "absent" | "unknown";
  rows: { fields: Record<string, unknown> }[];
  unknown: { reason: string; why?: string }[];
}
export interface ResultView {
  rows: Map<string, { providers: Record<string, ProviderView> }>;
}
export interface Box {
  track: string;
  title: string | undefined;
  label: string;
  artist: string | undefined;
}
export interface App {
  read(entity: string, keys: string[], providers: string[]): Promise<ResultView>;
  artistBoxes(trackIds: string[]): Promise<Box[]>;
  profileLabel(outcome: string): string;
  db: { down: boolean; calls: { table: string; ids: string[] }[] };
}

/** A fresh copy of the app (its runner, cache and fakes), as a new process would have it. */
export async function freshApp(): Promise<App> {
  vi.resetModules();
  const runnerModule: Record<string, unknown> = await import("../../src/runner.ts");
  const pageModule: Record<string, unknown> = await import("../../src/page.ts");
  const dbModule: Record<string, unknown> = await import("../../src/sources/db.ts");
  const runner = runnerModule.runner as {
    read(entity: string, keys: string[], providers: string[]): Promise<ResultView>;
  };
  return {
    read: (entity, keys, providers) => runner.read(entity, keys, providers),
    artistBoxes: pageModule.artistBoxes as App["artistBoxes"],
    profileLabel: pageModule.profileLabel as App["profileLabel"],
    db: dbModule.db as App["db"],
  };
}

export function provider(result: ResultView, row: string, id: string): ProviderView {
  const p = result.rows.get(row)?.providers[id];
  if (!p) throw new Error(`no ${id} for row ${row}`);
  return p;
}
