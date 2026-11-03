// Client of the labels service (owned by the rights team), faked in memory.
//
// The service has a batch endpoint, `getMany`, and is rate limited per client. It answers only the
// ids it knows: an id it does not know is simply not in the returned map. Tests switch it off with
// `labelsApi.fail` and read `labelsApi.calls`.

export interface Label {
  readonly name: string;
  readonly country: string;
}

const LABELS = new Map<string, Label>([
  ["l1", { name: "Hollowreed Records", country: "IT" }],
  ["l2", { name: "Saltmarsh Sound", country: "FR" }],
  ["l3", { name: "Northlight", country: "NO" }],
  ["l4", { name: "Brass Kettle", country: "GB" }],
  ["l5", { name: "Quiet Engine", country: "DE" }],
]);

export const labelsApi = {
  /** when true, every call fails with a connection reset */
  fail: false,
  /** the ids of every call, in order */
  calls: [] as string[][],
  async getMany(
    ids: string[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<Map<string, Label>> {
    labelsApi.calls.push([...ids]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    opts.signal?.throwIfAborted();
    if (labelsApi.fail) {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    const out = new Map<string, Label>();
    for (const id of ids) {
      const label = LABELS.get(id);
      if (label) out.set(id, label);
    }
    return out;
  },
};
