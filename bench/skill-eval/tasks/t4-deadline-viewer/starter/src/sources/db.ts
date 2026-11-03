// The catalog database, faked in memory: track titles. Fast.

export interface TrackRow {
  readonly title: string;
}

const TRACKS = new Map<string, TrackRow>([
  ["t1", { title: "Glass Harbour" }],
  ["t2", { title: "Night Drive" }],
  ["t3", { title: "Low Tide" }],
  ["t4", { title: "Paper Moons" }],
  ["t5", { title: "Ferrous" }],
  ["t6", { title: "Static Bloom" }],
]);

export const db = {
  calls: [] as string[][],
  async tracks(ids: readonly string[]): Promise<Map<string, TrackRow>> {
    db.calls.push([...ids]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const out = new Map<string, TrackRow>();
    for (const id of ids) {
      const row = TRACKS.get(id);
      if (row) out.set(id, row);
    }
    return out;
  },
};
