// The walk and the attribution over a hand-made ledger: what a base row gets from what was read.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { entity, hopgraph, type RelationDef } from "../../core/index.ts";
import { attribute } from "../attribution.ts";
import type { Ledger, Link, ProviderAnswer, RelationResult, StepRecord } from "../ledger.ts";
import { recordOf, say } from "../ledger.ts";
import type { PlannedRoute } from "../plan.ts";
import { type RefNode, RefStore, showKeys } from "../refs.ts";
import { absentTally, foundTally, outcomeOf, type Tally, unknownTally } from "../tally.ts";
import { walkPath } from "../walk.ts";

const entities = hopgraph<object, unknown>()
  .entities({
    track: entity({ key: z.string() }),
    email: entity({ key: z.string(), personal: true }),
    artist: entity({ key: z.string() }),
  })
  .graph().entities;
const refs = new RefStore(entities);
const t1 = refs.intern("track", "t1");
const anna = refs.intern("email", "anna@example.com");
const bob = refs.intern("email", "bob@example.com");
const a1 = refs.intern("artist", "a1");

const contact = { id: "track › email:contact" } as RelationDef;
const owner = { id: "email › artist:owner" } as RelationDef;
const CAP = { kind: "cap", limit: 50 } as const;

const link = (from: RefNode, to: RefNode, relation: string, ambiguous = false): Link => ({
  relation,
  strategy: "loader",
  from,
  to,
  attrs: {},
  ambiguous,
});

/** A ledger from tables of answers by relation (or provider) and ref id. */
function ledger(
  relations: Record<string, Record<string, Partial<RelationResult> & { tally: Tally }>>,
  providers: Record<string, Partial<ProviderAnswer> & { tally: Tally }>,
): Ledger {
  return {
    relation: (id, ref) => {
      const r = relations[id]?.[ref.id];
      if (!r) throw new Error(`unevaluated ${id} ${ref.id}`);
      return { links: [], steps: [], ...r };
    },
    provider: (_id, ref) => {
      const p = providers[ref.id];
      if (!p) throw new Error(`unevaluated provider ${ref.id}`);
      return { rows: [], steps: [], ...p };
    },
    hydration: () => undefined,
  };
}

describe("walkPath", () => {
  it("rows found below any link make the base row found; an unread branch stays listed", () => {
    const l = ledger(
      {
        [contact.id]: {
          [t1.id]: {
            tally: foundTally(),
            links: [link(t1, anna, contact.id), link(t1, bob, contact.id)],
          },
        },
      },
      {
        [anna.id]: { tally: foundTally(), rows: [{ bounced: false }] },
        [bob.id]: { tally: unknownTally({ reason: "failed" }) },
      },
    );
    const t = walkPath(l, [contact], "bounces", t1);
    expect(outcomeOf(t)).toBe("found");
    expect(t.unknown).toEqual([{ reason: "failed" }]);
  });

  it("nothing found below a relation that was cut is not an absence", () => {
    const l = ledger(
      {
        [contact.id]: {
          [t1.id]: { tally: foundTally([CAP]), links: [link(t1, anna, contact.id)] },
        },
      },
      { [anna.id]: { tally: absentTally() } },
    );
    const t = walkPath(l, [contact], "bounces", t1);
    expect(outcomeOf(t)).toBe("unknown");
    expect(t.cut).toEqual([CAP]);
  });

  it("whatever is read through an undecided candidate is marked ambiguous", () => {
    const l = ledger(
      {
        [contact.id]: {
          [t1.id]: { tally: foundTally(), links: [link(t1, anna, contact.id, true)] },
        },
      },
      { [anna.id]: { tally: absentTally() } },
    );
    expect(walkPath(l, [contact], "bounces", t1).unknown).toEqual([{ reason: "ambiguous" }]);
  });
});

describe("attribute", () => {
  it("rows once per key and index with every distinct chain; steps once; personal keys digested", () => {
    const step = (ref: RefNode): StepRecord => recordOf(contact.id, "header", ref, say.found());
    const viaAnna = link(t1, anna, contact.id);
    const l = ledger(
      {
        [contact.id]: {
          [t1.id]: { tally: foundTally(), links: [viaAnna, viaAnna], steps: [step(t1), step(t1)] },
        },
        [owner.id]: { [anna.id]: { tally: foundTally(), links: [link(anna, a1, owner.id)] } },
      },
      { [a1.id]: { tally: foundTally(), rows: [{ name: "Mira Volk" }] } },
    );
    const route = {
      base: "track",
      provider: { id: "profile" },
      combine: "union",
      paths: [[contact, owner]],
    } as unknown as PlannedRoute;
    const result = attribute(
      l,
      [route],
      t1,
      showKeys(entities, (e) => `${e}#digest`),
    );

    expect(result.providers.profile).toEqual({
      rows: [
        {
          ref: "a1",
          index: 0,
          fields: { name: "Mira Volk" },
          lineage: [
            [
              {
                relation: contact.id,
                strategy: "loader",
                from: "t1",
                to: "email#digest",
                attrs: {},
              },
              { relation: owner.id, strategy: "loader", from: "email#digest", to: "a1", attrs: {} },
            ],
          ],
        },
      ],
      outcome: "found",
      unknown: [],
      cut: [],
      coverage: [],
    });
    expect(result.steps).toEqual([
      { step: contact.id, loader: "header", ref: "t1", outcome: "found" },
    ]);
    expect(JSON.stringify(result)).not.toContain("anna@example.com");
  });
});
