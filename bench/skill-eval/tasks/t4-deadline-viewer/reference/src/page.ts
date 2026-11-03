// The track list page.

import { trackStreams, trackSummary } from "./graph.ts";
import { runner } from "./runner.ts";

export interface User {
  readonly id: string;
  readonly permissions: string[];
}

export type StreamsCell = number | "late" | "forbidden" | "none";

export interface PageRow {
  readonly track: string;
  readonly title: string;
  readonly streams: StreamsCell;
}

/** The page answers within this, whatever analytics does. */
const BUDGET_MS = 300;

/** One row per track, in the order asked. */
export async function renderPage(trackIds: string[], user: User): Promise<PageRow[]> {
  const mayReadAnalytics = user.permissions.includes("analytics");
  const result = await runner.read("track", trackIds, [trackSummary, trackStreams], {
    // epoch ms: past it, running loads are aborted and the read answers with what it has
    deadline: Date.now() + BUDGET_MS,
    // a viewer who may not read analytics: the loader is not run and the cache is not read
    readable: (connector) => (connector === "analytics" && !mayReadAnalytics ? "forbidden" : true),
    // and what such a viewer reads is never shared with one who may
    restriction: mayReadAnalytics ? "" : "no-analytics",
  });
  return trackIds.map((track) => {
    const p = result.rows.get(track)?.providers;
    const s = p?.trackStreams;
    let streams: StreamsCell;
    if (s?.outcome === "found") streams = s.rows[0]?.fields.streams ?? "none";
    else if (s?.outcome === "absent") streams = "none";
    else if (s?.unknown.some((u) => u.reason === "unread" && u.why === "forbidden")) streams = "forbidden";
    else streams = "late";
    return { track, title: p?.trackSummary.rows[0]?.fields.title ?? "", streams };
  });
}
