// Found by review of the scheduler. A run that failed stopped at once on the first failure it met:
// a refused approval held back only the jobs of later waves it could reach, so a job of a later
// wave on another branch still ran, and when its load threw an error the application declares
// fatal, the run rejected with that error, or with the refusal, by which came first. Two fatal
// errors of different waves raced the same way. Under the barrier the earliest wave's failure was
// always the one: nothing of a later wave had started.
//
// Fixed: a failure is held like a refusal (src/run/reads.ts): the jobs of later waves stop, the
// waves before it finish, and the run rejects with the earliest wave's failure, a refusal before an
// error thrown in the same wave.

import { CostChangedError, entity, envelope, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Quota extends Error {
  override name = "Quota";
  constructor(readonly source: string) {
    super(`quota of ${source} spent`);
  }
}

/** A track's statement, read from the track itself in wave 1 by `first` (metered, or fatal when
 *  `firstFails`), and its artist's profile, read in wave 2 by `quota`, on another branch. */
function build() {
  const t = { firstMs: 1, quotaMs: 1, firstFails: false, quotaFails: false };
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = {
    version: 1,
    batch: { by: "partition" },
    keep: () => "none" as const,
    partial: "keep",
  } as const;
  const first = g.loader({
    ...common,
    id: "first",
    keyedBy: "track",
    connectors: { allOf: ["warehouse"] },
    cost: { metered: { auto: 10, approve: 1000 } },
    price: async () => {
      await sleep(t.firstMs);
      return 50;
    },
    load: async (refs) => {
      await sleep(t.firstMs);
      if (t.firstFails) throw new Quota("first");
      return envelope(
        refs.map((r) => [r.key, { kind: "found", value: { royalties: 1 } }] as const),
      );
    },
  });
  const links = g.loader({
    ...common,
    id: "links",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: async (refs) =>
      envelope(refs.map((r) => [r.key, { kind: "found", value: { to: "a1" } }] as const)),
  });
  const quota = g.loader({
    ...common,
    id: "quota",
    keyedBy: "artist",
    connectors: { allOf: ["api"] },
    load: async (refs) => {
      await sleep(t.quotaMs);
      if (t.quotaFails) throw new Quota("quota");
      return envelope(
        refs.map((r) => [r.key, { kind: "found", value: { name: "Mira Volk" } }] as const),
      );
    },
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    strategies: (s) => [s(links, { project: (_ref, v) => [{ to: v.to }] })],
  });
  const m = { meta: { label: "x" } };
  const graph = g.graph(
    g.route(
      "track",
      g.provider("statement", {
        loader: first,
        temporal: "current",
        rows: "one",
        project: (v) => [v],
        raw: { royalties: m },
      }),
      g.itself("track"),
    ),
    g.route(
      "track",
      g.provider("profile", {
        loader: quota,
        temporal: "current",
        rows: "one",
        project: (v) => [v],
        raw: { name: m },
      }),
      g.path(performer),
    ),
  );
  const ask = (approved: Record<string, number> = {}) =>
    run(graph, {
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["statement", "profile"],
      ctx: {},
      restriction: "",
      readable: () => true,
      cache: { getMany: async () => new Map(), setMany: async () => undefined },
      limits: {},
      digest: (_entity, keyId) => keyId,
      approved,
      fatal: (e) => e instanceof Quota,
    });
  return { t, ask };
}

it("a refused approval of wave 1 fails the run before a fatal error of wave 2, whichever comes first", async () => {
  const b = build();
  const gated = await b.ask();
  const gate = gated.gates[0];
  if (!gate) throw new Error("expected a gate");
  b.t.quotaFails = true;
  const short = { [gate.id]: gate.bytes - 1 };
  for (const [firstMs, quotaMs] of [
    [30, 1],
    [1, 30],
  ] as const) {
    Object.assign(b.t, { firstMs, quotaMs });
    const error = await b.ask(short).catch((e: unknown) => e);
    expect(error, `price ${firstMs} ms, quota ${quotaMs} ms`).toBeInstanceOf(CostChangedError);
  }
});

it("a fatal error of wave 1 fails the run before one of wave 2, whichever comes first", async () => {
  const b = build();
  const gated = await b.ask();
  const gate = gated.gates[0];
  if (!gate) throw new Error("expected a gate");
  Object.assign(b.t, { firstFails: true, quotaFails: true });
  for (const [firstMs, quotaMs] of [
    [30, 1],
    [1, 30],
  ] as const) {
    Object.assign(b.t, { firstMs, quotaMs });
    const error = await b.ask({ [gate.id]: gate.bytes }).catch((e: unknown) => e);
    expect(error, `first ${firstMs} ms, quota ${quotaMs} ms`).toBeInstanceOf(Quota);
    expect((error as Quota).source).toBe("first");
  }
});
