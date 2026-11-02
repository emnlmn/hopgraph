// Found by review of the run code. Nothing starts once a run has failed, yet a load could: a call
// that threw an error the application declares fatal freed its connector slot as soon as it
// settled, while the run learned of the failure only once the error had climbed out of the job. A
// load waiting for that slot started in between, with a live signal, and for a metered loader that
// is a bill nobody will read.
//
// Fixed: the call tells the run of the failure where it is thrown, before its slot is free
// (src/run/calls.ts, src/run/stop.ts `fails`): the loads of its wave and of later ones stop, and the
// one waiting for the slot gives up.

import { type Envelope, entity, envelope, found, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Quota extends Error {
  override name = "Quota";
}

const graph = () =>
  hopgraph<Record<string, never>, { readonly label: string }, "db" | "wh">().entities({
    track: entity({ key: text }),
  });

const base = {
  ctx: {},
  readable: () => true as const,
  cache: { getMany: async () => new Map(), setMany: async () => undefined },
  fatal: (error: unknown) => error instanceof Quota,
};

it("the next batch of the same job does not start once one has failed the run", async () => {
  const started: { readonly key: string; readonly aborted: boolean }[] = [];
  const g = graph();
  const tracks = g.loader({
    id: "tracks",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 1 },
    load: async (refs, _ctx, _budget, signal) => {
      for (const r of refs) started.push({ key: r.key, aborted: signal.aborted });
      await sleep(1);
      if (refs.some((r) => r.key === "a")) throw new Quota("spent");
      return envelope(refs.map((r) => [r.key, found({ plays: 1 })]));
    },
  });

  await expect(
    run(
      g.graph(
        g.route(
          "track",
          g.provider("plays", {
            loader: tracks,
            temporal: "historical",
            rows: "one",
            project: (v) => [v],
            raw: { plays: { meta: { label: "Plays" } } },
          }),
          g.itself("track"),
        ),
      ),
      {
        ...base,
        refs: ["a", "b"].map((key) => ({ row: key, entity: "track", key })),
        providers: ["plays"],
        limits: { db: 1 },
      },
    ),
  ).rejects.toBeInstanceOf(Quota);
  await sleep(10);
  expect(started).toEqual([{ key: "a", aborted: false }]);
});

it("a metered load of the same wave waiting for the slot does not start its billed call", async () => {
  const billed: { readonly budget: number | undefined; readonly aborted: boolean }[] = [];
  const g = graph();
  const field = (label: string) => ({ meta: { label } });
  const failing = g.loader({
    id: "failing",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    batch: { by: "partition" },
    load: async (): Promise<Envelope<string, { readonly n: number }>> => {
      await sleep(10);
      throw new Quota("spent");
    },
  });
  const metered = g.loader({
    id: "metered",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    batch: { by: "partition" },
    cost: { metered: { auto: 100, approve: 1000 } },
    price: async () => 50,
    load: async (refs, _ctx, budget, signal) => {
      billed.push({ budget: budget.maxBytes, aborted: signal.aborted });
      return envelope(
        refs.map((r) => [r.key, found({ n: 1 })]),
        50,
      );
    },
  });
  const one = { temporal: "current", rows: "one", raw: { n: field("N") } } as const;

  await expect(
    run(
      g.graph(
        g.route(
          "track",
          g.provider("a", { ...one, loader: failing, project: (v) => [{ n: v.n }] }),
          g.itself("track"),
        ),
        g.route(
          "track",
          g.provider("b", { ...one, loader: metered, project: (v) => [{ n: v.n }] }),
          g.itself("track"),
        ),
      ),
      {
        ...base,
        refs: [{ row: "r1", entity: "track", key: "t1" }],
        providers: ["a", "b"],
        limits: { wh: 1 },
      },
    ),
  ).rejects.toBeInstanceOf(Quota);
  await sleep(10);
  expect(billed).toEqual([]);
});
