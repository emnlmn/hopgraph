// Loose views of the app's modules: the hidden tests compile against any solution's types, so a
// type error in a run is always the solution's own.
import { vi } from "vitest";

export type Stat =
  | { outcome: "found"; value: number }
  | { outcome: "absent" }
  | { outcome: "unknown"; reason: string };
export interface TrackStats {
  title: string | undefined;
  streams: Stat;
  skipRate: Stat;
}
export interface Answer {
  status: string;
  result: Map<string, TrackStats>;
  gates?: { id: string; bytes: number }[];
  resume?: (approved: Record<string, number>) => Promise<Answer>;
}
export interface Warehouse {
  billed: number;
  dryRuns: { table: string; tracks: number; bytes: number }[];
  queries: { table: string; tracks: number; maxBytes: number | undefined; billed: number }[];
}
export interface App {
  streamsFor(trackIds: string[], approvals?: Record<string, number>): Promise<Answer>;
  warehouse: Warehouse;
}

/** A fresh copy of the app (its runner, cache and fakes), as a new process would have it. */
export async function freshApp(): Promise<App> {
  vi.resetModules();
  const streamsModule: Record<string, unknown> = await import("../../src/streams.ts");
  const warehouseModule: Record<string, unknown> = await import("../../src/sources/warehouse.ts");
  return {
    streamsFor: streamsModule.streamsFor as App["streamsFor"],
    warehouse: warehouseModule.warehouse as Warehouse,
  };
}

/** t001 … t<n> */
export const tracks = (n: number) =>
  Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(3, "0")}`);

export const GB = 1_000_000_000;
export const MB = 1_000_000;

/** Approves every gate of an answer at the bytes it showed. */
export function approveAll(answer: Answer): Record<string, number> {
  return Object.fromEntries((answer.gates ?? []).map((g) => [g.id, g.bytes]));
}

export function stat(answer: Answer, track: string): TrackStats {
  const s = answer.result.get(track);
  if (!s) throw new Error(`no stats for ${track}`);
  return s;
}
