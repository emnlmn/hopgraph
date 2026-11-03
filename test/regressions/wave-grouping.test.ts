// Found by test/props/failures.test.ts, "with retries enough for every transient failure, the
// answer is the one of sources that never failed": a retry takes turns, and the waves gathered a
// metered loader's keys otherwise. The same held without any failure, and test/props/
// determinism.test.ts reached it from random seeds. A step whose next read was already answered by
// the wave before (another step read that loader key) did not wait for a wave: it finished at
// once, and the step after it offered its refs to the next wave. Whether that read was answered
// when the step asked depended on which of two calls finished first. Here track t1 reaches
// artist a1 by relation x (loader `links`), and artist a2 by relation y, a fallback whose first
// strategy (`legacy`) fails and whose second reads `links` again. The provider over both reads a
// metered loader auto-approved for one key at a time; x's verification reads a1 through it first.
// When `links` answered before `legacy`, y finished at once, the provider offered a2 to the wave
// that verified a1, and the two keys priced together stopped at a gate. When `legacy` answered
// first, y waited a wave, a1 and a2 were priced apart, each under the auto cap, and the run was
// complete.
//
// Fixed: every read takes a wave, one more than its step had reached, even when its keys are
// answered already, and a loader's job of a wave starts once nothing behind it can add keys to it
// (src/run/schedule.ts). Which keys share a job depends on the plan and the answers: here a1 and a2
// are priced apart whichever call finishes first.

import {
  type Envelope,
  entity,
  envelope,
  hopgraph,
  type Retention,
  run,
  type Schema,
} from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Runs the graph, answering `links` and `legacy` in the order given, once both are called. */
async function play(first: "links" | "legacy") {
  const waiting = new Map<string, () => void>();
  const held =
    <V>(name: string, answer: () => Envelope<string, V>) =>
    () =>
      new Promise<Envelope<string, V>>((resolve) => {
        waiting.set(name, () => resolve(answer()));
      });
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = {
    version: 1,
    batch: { by: "partition" },
    keep: (): Retention => "day",
    partial: "keep",
  } as const;
  const links = g.loader({
    ...common,
    id: "links",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: held("links", () =>
      envelope([["t1", { kind: "found", value: { x: "a1", y: "a2" } }] as const]),
    ),
  });
  const legacy = g.loader({
    ...common,
    id: "legacy",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: held("legacy", () =>
      envelope([["t1", { kind: "unknown", reason: { reason: "failed" } }]]),
    ),
  });
  const profiles = g.loader({
    ...common,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["wh"] },
    cost: { metered: { auto: 1, approve: 100 } },
    price: async (refs) => refs.length,
    load: async (refs) =>
      envelope(
        refs.map((r) => [r.key, { kind: "found", value: { name: r.key } }] as const),
        refs.length,
      ),
  });
  const x = g.relation("track", "artist", "x", {
    cardinality: "N:1",
    strategies: (s) => [s(links, { project: (_ref, v) => [{ to: v.x }] })],
    verify: (v) => v(profiles, (candidates) => candidates.map(() => "keep")),
  });
  const y = g.relation("track", "artist", "y", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(legacy, { project: () => [] }),
      s(links, { project: (_ref, v) => [{ to: v.y }] }),
    ],
  });
  const profile = g.provider("profile", {
    loader: profiles,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: { meta: { label: "Name" } } },
  });

  const running = run(g.graph(g.route("track", profile, g.union(g.path(x), g.path(y)))), {
    refs: [{ row: "r1", entity: "track", key: "t1" }],
    providers: ["profile"],
    ctx: {},
    restriction: "",
    readable: () => true,
    cache: { getMany: async () => new Map(), setMany: async () => undefined },
    limits: {},
    digest: (_entity, keyId) => keyId,
  });
  for (let i = 0; i < 100 && waiting.size < 2; i++) await turn();
  const second = first === "links" ? "legacy" : "links";
  waiting.get(first)?.();
  for (let i = 0; i < 10; i++) await turn();
  waiting.get(second)?.();
  const result = await running;
  return { status: result.status, profile: result.rows.get("r1")?.providers.profile?.outcome };
}

it("the same run answers the same whichever of two calls finishes first", async () => {
  const linksFirst = await play("links");
  const legacyFirst = await play("legacy");

  expect(legacyFirst).toEqual({ status: "complete", profile: "found" });
  // links first: a1 and a2 are priced together, at 2 bytes over the auto cap of 1, and gated
  expect(linksFirst).toEqual(legacyFirst);
});
