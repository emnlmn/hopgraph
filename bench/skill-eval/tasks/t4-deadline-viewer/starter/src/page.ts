// The track list page.

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

/** One row per track, in the order asked. */
export async function renderPage(trackIds: string[], user: User): Promise<PageRow[]> {
  throw new Error("not implemented");
}
