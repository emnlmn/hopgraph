// The catalog database, faked in memory: track titles. Free to read.

export interface TrackRow {
  readonly title: string;
}

const TRACKS = new Map<string, TrackRow>();
for (let i = 1; i <= 700; i++) {
  const id = `t${String(i).padStart(3, "0")}`;
  TRACKS.set(id, { title: `Track ${i}` });
}

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
