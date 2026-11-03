// Client of the analytics API, faked in memory. It is slow under load (tests set `delayMs`), and it
// answers only the tracks it has data for: a track it has no data for is not in the returned map.
// It honours `signal`: an aborted call rejects with the signal's reason.

export interface StreamsRow {
  readonly streams: number;
}

const DATA = new Map<string, StreamsRow>([
  ["t1", { streams: 120_000 }],
  ["t2", { streams: 45_000 }],
  ["t3", { streams: 9_800 }],
  // t4: released yesterday, no analytics yet
  ["t5", { streams: 310 }],
  ["t6", { streams: 77_000 }],
]);

export const analyticsApi = {
  /** how long a call takes, in ms */
  delayMs: 5,
  /** the ids of every call, in order */
  calls: [] as string[][],
  get(ids: string[], opts: { signal?: AbortSignal } = {}): Promise<Map<string, StreamsRow>> {
    analyticsApi.calls.push([...ids]);
    const { signal } = opts;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        const out = new Map<string, StreamsRow>();
        for (const id of ids) {
          const row = DATA.get(id);
          if (row) out.set(id, row);
        }
        resolve(out);
      }, analyticsApi.delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
