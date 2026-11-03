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
export interface App {
  read(entity: string, keys: string[], providers: string[]): Promise<ResultView>;
  db: { fail: boolean; calls: { table: string; ids: string[] }[] };
  labelsApi: { fail: boolean; calls: string[][] };
  graph: unknown;
}

/** A fresh copy of the app (its runner, cache and fakes), as a new process would have it. */
export async function freshApp(): Promise<App> {
  vi.resetModules();
  const runnerModule: Record<string, unknown> = await import("../../src/runner.ts");
  const graphModule: Record<string, unknown> = await import("../../src/graph.ts");
  const dbModule: Record<string, unknown> = await import("../../src/sources/db.ts");
  const labelsModule: Record<string, unknown> = await import("../../src/sources/labels.ts");
  const runner = runnerModule.runner as {
    read(entity: string, keys: string[], providers: string[]): Promise<ResultView>;
  };
  return {
    read: (entity, keys, providers) => runner.read(entity, keys, providers),
    db: dbModule.db as App["db"],
    labelsApi: labelsModule.labelsApi as App["labelsApi"],
    graph: graphModule.graph,
  };
}

export function provider(result: ResultView, row: string, id: string): ProviderView {
  const p = result.rows.get(row)?.providers[id];
  if (!p) throw new Error(`no ${id} for row ${row}`);
  return p;
}
