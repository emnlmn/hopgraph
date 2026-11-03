// Found by test/props/failures.test.ts, "a breaker that opens leaves keys unknown, never absent
// where they were found", from a random seed (HOPGRAPH_SEED=1804731274, HOPGRAPH_SCALE=10). A
// track's artist comes from `primary` (a1), else from `backup` (a2); a1 has a profile, a2 none.
// With primary's circuit open, the fallback fell through it as through a strategy that read and
// found nothing, backup led to a2, and the run said the profile was absent, where a run with
// primary up finds it.
//
// Fixed by the decision of DESIGN.md §3.3: a fallback still goes on past a strategy it could not
// read, but the strategy that finds keeps that strategy's reason beside it, so whatever is read
// through it is never absent: here the profile is unknown, failed with the circuit open. What the
// next strategy finds stands, the reason beside it, even where the first would have led to an
// absence. A fallback whose strategies before all read and found nothing still gives absent.

import { createHealth, entity, envelope, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

class Down extends Error {
  override name = "Down";
}

/** A track's artist from `primary` (a1), else from `backup` (a2), under a breaker that opens on
 *  `primary`'s first failure; `profiled` is the artist with a profile. */
function build(profiled: "a1" | "a2") {
  const source = { down: false };
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
  const links = (id: string, connector: string, to: string) =>
    g.loader({
      ...common,
      id,
      keyedBy: "track",
      connectors: { allOf: [connector] },
      load: async (refs) => {
        if (id === "primary" && source.down) throw new Down();
        return envelope(refs.map((r) => [r.key, { kind: "found", value: { to } }] as const));
      },
    });
  const profiles = g.loader({
    ...common,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["api"] },
    load: async (refs) =>
      envelope(
        refs.map((r) =>
          r.key === profiled
            ? ([r.key, { kind: "found", value: { name: "Mira Volk" } }] as const)
            : ([r.key, { kind: "absent" }] as const),
        ),
      ),
  });
  const to = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(links("primary", "db", "a1"), { project: to }),
      s(links("backup", "wh", "a2"), { project: to }),
    ],
  });
  const health = createHealth({
    db: { breaker: { failures: 1, windowMs: 60_000, coolDownMs: 60_000 } },
  });
  const graph = g.graph(
    g.route(
      "track",
      g.provider("profile", {
        loader: profiles,
        temporal: "current",
        rows: "one",
        project: (v) => [v],
        raw: { name: { meta: { label: "Name" } } },
      }),
      g.path(performer),
    ),
  );
  const ask = () =>
    run(graph, {
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["profile"],
      ctx: {},
      restriction: "",
      readable: () => true,
      cache: { getMany: async () => new Map(), setMany: async () => undefined },
      limits: {},
      digest: (_entity, keyId) => keyId,
      health,
    });
  const profile = async () => (await ask()).rows.get("r1")?.providers.profile;
  /** primary goes down, its circuit opens on the first failure, and it comes up again: the
   *  circuit stays open for a minute */
  const breakPrimary = async () => {
    source.down = true;
    await ask();
    source.down = false;
    expect(health.state("db")).toBe("open");
  };
  return { profile, breakPrimary };
}

const OPEN = { reason: "failed", why: "open", connectors: ["db"] };

it("a fallback whose first strategy's circuit is open never makes absent what it finds", async () => {
  const { profile, breakPrimary } = build("a1");
  expect((await profile())?.outcome).toBe("found");
  await breakPrimary();

  // backup leads to a2, and its absent profile is unknown: primary, not read, led elsewhere
  const skipped = await profile();
  expect(skipped?.outcome).toBe("unknown");
  expect(skipped?.unknown).toEqual([OPEN]);
  expect(skipped?.rows).toEqual([]);
});

it("what a fallback finds past a strategy whose circuit is open stands, with that strategy's reason", async () => {
  const { profile, breakPrimary } = build("a2");
  expect((await profile())?.outcome).toBe("absent");
  await breakPrimary();

  // backup leads to a2, which has a profile: found, though primary would have led to a1, absent
  const skipped = await profile();
  expect(skipped?.outcome).toBe("found");
  expect(skipped?.unknown).toEqual([OPEN]);
  expect(skipped?.rows.map((r) => r.fields)).toEqual([{ name: "Mira Volk" }]);
});
