// Found by review of the run code. A job that fails the run (here its cache port throws) recorded
// the failure, then described the error for its span, then let the reads waiting for it go on. An
// error whose `code` getter throws made the description throw, so the reads never went on, the
// failed wave never went quiet, and the run hung past its deadline: the deadline stops what runs,
// not a job that is over but never said so.
//
// Fixed: a job lets its reads go on before it records anything on its span (src/run/reads.ts), and
// describing an error never throws (src/run/calls.ts `described`).

import { type CachePort, entity, envelope, found, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

it("a job whose error cannot be described still settles the run", async () => {
  const hostile = new Error("cache down");
  Object.defineProperty(hostile, "code", {
    get() {
      throw new Error("no code for you");
    },
  });
  const cache: CachePort = {
    getMany: async () => {
      throw hostile;
    },
    setMany: async () => undefined,
  };
  const g = hopgraph<Record<string, never>, { readonly label: string }>().entities({
    track: entity({ key: text }),
  });
  const tracks = g.loader({
    id: "tracks",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch: { by: "partition" },
    load: async (refs) => envelope(refs.map((r) => [r.key, found({ plays: 1 })])),
  });

  const running = run(
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
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["plays"],
      ctx: {},
      readable: () => true,
      cache,
      limits: {},
      deadline: Date.now() + 50,
    },
  );
  const settled = await Promise.race([
    running.then(
      () => "answered",
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 500)),
  ]);
  expect(settled).toBe(hostile);
});
