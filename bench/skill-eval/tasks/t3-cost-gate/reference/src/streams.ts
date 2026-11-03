// Stats of a list of tracks for the label dashboard: title, streams, skip rate.

import type { RunResult } from "hopgraph";
import { trackInfo, trackSkips, trackStreams } from "./graph.ts";
import { runner } from "./runner.ts";

/** One value as the dashboard shows it: the value, "no data", or why we could not read it. */
export type Stat<V> =
  | { readonly outcome: "found"; readonly value: V }
  | { readonly outcome: "absent" }
  | { readonly outcome: "unknown"; readonly reason: string };

export interface TrackStats {
  readonly title: string | undefined;
  readonly streams: Stat<number>;
  readonly skipRate: Stat<number>;
}

/** A gate: a warehouse read that waits for a person to approve its bytes. */
export interface Gate {
  readonly id: string;
  readonly bytes: number;
}

export type StreamsAnswer =
  | { readonly status: "done"; readonly result: Map<string, TrackStats> }
  | {
      readonly status: "needs-approval";
      /** what could be read without approval; the gated values are unknown: awaiting_approval */
      readonly result: Map<string, TrackStats>;
      readonly gates: readonly Gate[];
      /** the same request again, with these approvals (bytes by gate id) */
      resume(approved: Record<string, number>): Promise<StreamsAnswer>;
    };

type Asked = readonly [typeof trackInfo, typeof trackStreams, typeof trackSkips];

function stat<V>(
  p: { outcome: "found" | "absent" | "unknown"; unknown: readonly { reason: string }[] },
  value: V | undefined,
): Stat<V> {
  if (p.outcome === "found" && value !== undefined) return { outcome: "found", value };
  if (p.outcome === "absent") return { outcome: "absent" };
  return { outcome: "unknown", reason: p.unknown[0]?.reason ?? "failed" };
}

/** The dashboard's view of a run's result, per track id. */
export function toStats(result: RunResult<Asked>): Map<string, TrackStats> {
  const out = new Map<string, TrackStats>();
  for (const [id, row] of result.rows) {
    const { trackInfo: info, trackStreams: s, trackSkips: k } = row.providers;
    out.set(id, {
      title: info.rows[0]?.fields.title,
      streams: stat(s, s.rows[0]?.fields.streams),
      skipRate: stat(k, k.rows[0]?.fields.skipRate),
    });
  }
  return out;
}

export function streamsFor(
  trackIds: string[],
  approvals: Record<string, number> = {},
): Promise<StreamsAnswer> {
  return read(trackIds, approvals, undefined);
}

async function read(
  trackIds: string[],
  approved: Record<string, number>,
  prices: ReadonlyMap<string, number> | undefined,
): Promise<StreamsAnswer> {
  const result = await runner.read("track", trackIds, [trackInfo, trackStreams, trackSkips], {
    approved,
    // the prices the run before measured: a resume does not price the warehouse again
    ...(prices ? { prices } : {}),
  });
  if (result.status !== "gated") return { status: "done", result: toStats(result) };
  return {
    status: "needs-approval",
    result: toStats(result),
    gates: result.gates.map((g) => ({ id: g.id, bytes: g.bytes })),
    resume: (more) => read(trackIds, { ...approved, ...more }, result.prices),
  };
}
