// What every step evaluator relies on: a read answers every ref it was asked, and a relation has
// at least one strategy. A graph built by hand with a relation and no strategy is refused before
// anything is read, as the builder refuses it.

import { expect, it } from "vitest";
import { run } from "../index.ts";
import { RefStore } from "../refs.ts";
import { answerOf } from "../step.ts";
import { fake, free, m, newGraph, options, refs } from "./support.ts";

it("a read that left one of its refs unanswered is a bug of the run's: HG_INTERNAL", () => {
  const ref = new RefStore(newGraph().graph().entities).intern("track", "t1");
  const read = {
    answers: new Map(),
    cached: 0,
    loaded: new Set<string>(),
    billedBytes: 0,
    errors: [],
    retries: 0,
  };
  expect(() => answerOf(read, ref)).toThrow(expect.objectContaining({ code: "HG_INTERNAL" }));
});

it.each(["union", "fallback"] as const)(
  "a hand-built relation with no strategy (%s) is refused, HG_SPEC, before anything is read",
  async (combine) => {
    const f = {
      recordings: fake<{ master: string }>({ found: { t1: { master: "m1" } } }),
      masterInfo: fake<{ minutes: number }>({ found: { m1: { minutes: 3 } } }),
    };
    const g = newGraph();
    const recordings = g.loader({
      ...free,
      id: "recordings",
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      load: f.recordings.load,
    });
    const masterInfo = g.loader({
      ...free,
      id: "masterInfo",
      keyedBy: "master",
      connectors: { allOf: ["db"] },
      load: f.masterInfo.load,
    });
    const mastered = g.relation("track", "master", "mastered", {
      cardinality: "N:1",
      strategies: (s) => [s(recordings, { project: (_ref, v) => [{ to: v.master }] })],
    });
    const info = g.provider("masterInfo", {
      loader: masterInfo,
      temporal: "current",
      rows: "one",
      project: (v) => [{ minutes: v.minutes }],
      raw: { minutes: m("Minutes") },
    });
    const graph = g.graph(g.route("track", info, g.path(mastered)));
    const relations = new Map(
      [...graph.relations].map(([id, r]) => [id, { ...r, combine, strategies: [] }]),
    );

    const error = await run(
      { ...graph, relations },
      options({ refs: refs("track", "t1"), providers: ["masterInfo"] }),
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "HG_SPEC",
      message: expect.stringContaining('relation "track › master:mastered" has no strategy'),
    });
    expect([...f.recordings.calls, ...f.masterInfo.calls]).toEqual([]);
  },
);
