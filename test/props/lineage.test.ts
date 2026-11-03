// Lineage and keys (DESIGN.md §5.5, §6): every chain of a provider row starts at its base row,
// follows declared relations along one of the route's paths, link after link, each link made by
// its strategy's projection of what the run read for the link's source, and ends at the row's
// key. A personal key appears nowhere in a result but as its digest.

import { describe, expect } from "vitest";
import { playAll, shower } from "./harness.ts";
import { CacheModel, readsOf } from "./oracle.ts";
import { property } from "./property.ts";
import { KEYS, keyOf, type RelationSpec, scenarios, targetsOf } from "./scenario.ts";

const graphs = scenarios({ callFailures: true, metered: true });

describe("lineage", () => {
  property(
    "every chain starts at its base row and follows declared relations",
    graphs,
    async (s) => {
      const show = shower(s);
      const cache = new CacheModel();
      const relations = new Map(s.relations.map((r) => [r.id, r]));
      for (const played of (await playAll(s)).played) {
        const reads = readsOf(s, played, cache);
        cache.apply(s, played);
        if (played.outcome.kind !== "result") continue;
        for (const base of played.request.rows) {
          const answer = played.outcome.result.rows.get(base.row);
          if (!answer) continue;
          for (const [id, p] of Object.entries(answer.providers)) {
            const provider = s.providers.find((x) => x.id === id);
            const route = s.routes.find((r) => r.base === base.entity && r.provider === id);
            const at = `${played.label}: ${base.row} › ${id}`;
            for (const row of p.rows) {
              expect(row.lineage.length, `${at}: a row with no chain`).toBeGreaterThan(0);
              for (const chain of row.lineage) {
                const path = chain.map((l) => l.relation);
                if (route?.paths === "itself")
                  expect(path, `${at}: "itself" took relations`).toEqual([]);
                else
                  expect(
                    route?.paths.map((x) => x.join(" · ")),
                    `${at}: not a path of its route`,
                  ).toContain(path.join(" · "));
                // from the base row, link after link, to the row's key
                let entity = base.entity;
                let key = base.key;
                for (const link of chain) {
                  const r = relations.get(link.relation) as RelationSpec;
                  expect(r.from, `${at}: ${link.relation} after ${entity}`).toBe(entity);
                  expect(link.from, `${at}: a link that does not start where the last ended`).toBe(
                    show(entity, key),
                  );
                  const strategy = r.strategies.find((st) => st.loader === link.strategy);
                  expect(
                    strategy,
                    `${at}: ${link.strategy} is no strategy of ${r.id}`,
                  ).toBeDefined();
                  // the link is the projection of what the run read for its source
                  const target = r.strategies
                    .filter((st) => st.loader === link.strategy)
                    .flatMap((st) => {
                      const a = reads(st.loader, key);
                      return a.kind === "found" ? targetsOf(st.pick, a.value) : [];
                    })
                    .find((i) => show(r.to, keyOf(r.to, i)) === link.to);
                  expect(
                    target,
                    `${at}: ${link.relation} links ${link.from} to ${link.to}`,
                  ).toBeDefined();
                  expect(link.attrs).toEqual({ n: target });
                  entity = r.to;
                  key = keyOf(r.to, target as number);
                }
                expect(entity, `${at}: the chain ends at another entity`).toBe(provider?.entity);
                expect(row.ref, `${at}: the chain ends at another key`).toBe(show(entity, key));
              }
            }
          }
        }
      }
    },
  );

  property("a personal key appears only as its digest", graphs, async (s) => {
    const personal = s.entities.filter((e) => e.personal).map((e) => e.name);
    for (const played of (await playAll(s)).played) {
      const text =
        played.outcome.kind === "result"
          ? JSON.stringify(played.outcome.result, (_k, v: unknown) =>
              v instanceof Map ? Object.fromEntries(v) : v,
            )
          : `${String(played.outcome.error)} ${JSON.stringify(played.outcome.error)}`;
      for (const entity of personal)
        for (let i = 0; i < KEYS; i++) {
          const key = keyOf(entity, i);
          expect(text.includes(key), `${played.label}: ${key} shows`).toBe(false);
        }
      // and where a personal key was read, its digest stands for it
      if (played.outcome.kind === "result" && personal.length > 0)
        for (const r of played.outcome.result.rows.values())
          for (const step of r.steps)
            if (personal.some((e) => step.ref.startsWith(`${e}#`)))
              expect(step.ref).toMatch(/^e\d#[0-9a-f]{8}$/);
    }
  });
});
