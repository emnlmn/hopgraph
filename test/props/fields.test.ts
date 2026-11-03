// Field schemas (DESIGN.md §5.6): a provider's fields may declare a schema, and a run that
// validates "strict" checks each value a row holds against its field's schema, the raw ones as
// the source gave them and the derived ones as computed from the parsed raw ones. A row that fails
// fails its ref: the provider's answer for that ref is unknown, failed, and the provider step of
// the trace counts it under HG_INVALID. Under "boundaries" and "off" no field schema runs.
// Schemas may answer later; the run waits for them, and reads, answers and makes its jobs and
// waves as it would without them.
//
// Every scenario here is played over the same sources and timing with and without field schemas,
// and the plays are compared run by run: a schema that accepts everything, as it is or after a
// pause, changes nothing; one that rejects everything changes nothing unless the run is strict;
// and a strict run with a field that rejects its values fails the refs that hold it, and only those.

import fc from "fast-check";
import type { RowResult, RowStep, Schema } from "hopgraph";
import { describe, expect, it } from "vitest";
import { type Played, type Player, playAll, type Variant } from "./harness.ts";
import { type NormalProvider, normalOutcome, normalRow, sortedDistinct } from "./oracle.ts";
import { property } from "./property.ts";
import { type ProviderSpec, scenarios } from "./scenario.ts";

const timed = scenarios({ metered: true, callFailures: true });

type Fields = NonNullable<Variant["fields"]>;

// ---------------------------------------------------------------- the schemas

const NO = { issues: [{ message: "no" }] };

function schemaOf(validate: Schema<unknown>["~standard"]["validate"]): Schema<unknown> {
  return { "~standard": { version: 1, vendor: "props", validate } };
}

/** FNV-1a of a text: what a field's schema does is a function of the scenario's seed, the provider
 *  and the field, so a scenario that fails fails again. */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** How long a field's schema takes: 0 to 3 microtasks, then 1 to 3 turns of the event loop. */
async function pause(delay: number): Promise<void> {
  for (let i = 0; i < Math.min(delay, 3); i++) await Promise.resolve();
  for (let i = 3; i < delay; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const delayOf = (seed: number, provider: string, field: string) =>
  hashOf(`${seed} ${provider} ${field}`) % 7;

/** Every field accepts every value as it is: at once, or after a pause that is the field's own. */
function accepting(style: "sync" | "async", seed: number): Fields {
  return (provider, field) =>
    style === "sync"
      ? schemaOf((value) => ({ value }))
      : schemaOf(async (value) => {
          await pause(delayOf(seed, provider, field));
          return { value };
        });
}

/** Every field rejects every value: by its issues, by its issues after a pause, or by throwing,
 *  whichever is the field's own. */
function rejecting(seed: number): Fields {
  return (provider, field) => {
    const h = hashOf(`${seed} ${provider} ${field}`);
    const way = (h >>> 8) % 3;
    if (way === 0) return schemaOf(() => NO);
    if (way === 1)
      return schemaOf(async () => {
        await pause(h % 7);
        return NO;
      });
    return schemaOf(() => {
      throw new Error("no");
    });
  };
}

/** One field of one provider rejects its values; the others accept theirs, or declare none. */
function rejectingOne(
  provider: string,
  field: string,
  style: "sync" | "async",
  others: Fields | undefined,
  seed: number,
): Fields {
  const rejects =
    style === "sync"
      ? schemaOf(() => NO)
      : schemaOf(async () => {
          await pause(delayOf(seed, provider, field));
          return NO;
        });
  return (p, f) => (p === provider && f === field ? rejects : others?.(p, f));
}

// ---------------------------------------------------------------- what a play did

/** Every call and dry run, with its keys: what the run read, in no order. */
function callsOf(p: Played): string[] {
  return p.events
    .flatMap((e) =>
      e.kind === "load"
        ? [`load ${e.loader} ${e.keys.join(" ")} #${e.attempt}`]
        : e.kind === "price"
          ? [`price ${e.loader} ${e.keys.join(" ")} #${e.attempt} ${e.bytes}`]
          : [],
    )
    .sort();
}

/** Every job with its wave and what it did, in no order: jobs end in the order timing gives. */
function jobsOf(p: Played): string[] {
  return p.events
    .flatMap((e) =>
      e.kind === "batch"
        ? [
            `${e.batch.loader} in wave ${e.batch.wave}: ${e.batch.keys} keys, ` +
              `${e.batch.hits} hits, ${e.batch.lookups} lookups`,
          ]
        : [],
    )
    .sort();
}

/** The runs of two plays are the same, run by run: they answer the same (rows, fields, lineage,
 *  steps, gates, the trace time aside, or the same error), read the same keys in the same calls,
 *  and make the same jobs in the same waves. */
function expectSame(bare: Player, other: Player, what: string): void {
  expect(
    other.played.map((p) => p.label),
    what,
  ).toEqual(bare.played.map((p) => p.label));
  bare.played.forEach((first, i) => {
    const second = other.played[i] as Played;
    const at = `${what}: ${first.label}`;
    expect(normalOutcome(second), at).toEqual(normalOutcome(first));
    // a run that failed stopped where timing left it: its record is not compared
    if (first.outcome.kind !== "result") return;
    expect(callsOf(second), `${at}: calls`).toEqual(callsOf(first));
    expect(jobsOf(second), `${at}: jobs and waves`).toEqual(jobsOf(first));
  });
}

/** A provider the run asks for and one of its fields, by index; how the field rejects, and what the
 *  other fields declare. */
const rejections = fc.record({
  s: timed,
  provider: fc.nat(),
  field: fc.nat(),
  style: fc.constantFrom("sync" as const, "async" as const),
  others: fc.constantFrom("none" as const, "sync" as const, "async" as const),
});

type Rejection = typeof rejections extends fc.Arbitrary<infer C> ? C : never;

let ran = false;
let refuted = false;
let met = 0;

async function rejectOne({ s, provider, field, style, others }: Rejection): Promise<void> {
  // a provider the run asks for, and one of its fields: `a` is in every row, `b` in some, and
  // `twice` (of a derived provider) in every row
  const ids = s.request.providers;
  const id = ids[provider % ids.length] as string;
  const spec = s.providers.find((p) => p.id === id) as ProviderSpec;
  const names = spec.derived ? ["a", "b", "twice"] : ["a", "b"];
  const name = names[field % names.length] as string;
  const rejects = rejectingOne(
    id,
    name,
    style,
    others === "none" ? undefined : accepting(others, s.timing[1]),
    s.timing[1],
  );

  const [bare, rejected] = await Promise.all([
    playAll(s, s.timing[0], undefined, "plan", { validate: "strict" }),
    playAll(s, s.timing[0], undefined, "plan", { validate: "strict", fields: rejects }),
  ]);
  expect(
    rejected.played.map((p) => p.label),
    "the runs",
  ).toEqual(bare.played.map((p) => p.label));
  bare.played.forEach((first, i) => {
    const second = rejected.played[i] as Played;
    const at = `${first.label}, ${id}.${name} rejecting`;
    if (first.outcome.kind !== "result" || second.outcome.kind !== "result") {
      expect(normalOutcome(second), at).toEqual(normalOutcome(first));
      return;
    }
    const failed = new Set<string>();
    for (const [row, before] of first.outcome.result.rows) {
      const after = second.outcome.result.rows.get(row);
      expect(after, `${at}: ${row} is answered`).toBeDefined();
      for (const ref of checkedRow(`${at}: ${row}`, id, name, before, after as RowResult))
        failed.add(ref);
    }
    // the provider step of the trace counts the refs that failed their schemas
    const counted = (p: Played) =>
      (p.outcome.kind === "result" ? p.outcome.result.trace : [])
        .filter((t) => t.step === `provider:${id}`)
        .flatMap((t) => t.errors)
        .filter((e) => e.code === "HG_INVALID")
        .reduce((sum, e) => sum + e.keys, 0);
    expect(counted(first), `${at}: refs failed by a schema, without schemas`).toBe(0);
    expect(counted(second), `${at}: refs failed by a schema`).toBe(failed.size);
    ran = true;
    met += failed.size;
  });
}

const holds = (row: { readonly fields: unknown }, name: string) =>
  (row.fields as Record<string, unknown>)[name] !== undefined;

/**
 * One base row's answer with and without a field that rejects its values: the refs of provider
 * `id` that were found with a row holding the field are unknown, failed, with no rows left; every
 * other step, and every other provider, answers as it did. Returns those refs.
 */
function checkedRow(
  at: string,
  id: string,
  name: string,
  before: RowResult,
  after: RowResult,
): Set<string> {
  const mine = (st: RowStep) => st.step === `provider:${id}`;
  const was = normalRow(before);
  const now = normalRow(after);
  const failed = new Set<string>();
  const rows = before.providers[id]?.rows ?? [];
  for (const st of before.steps)
    if (mine(st) && st.outcome === "found" && rows.some((r) => r.ref === st.ref && holds(r, name)))
      failed.add(st.ref);

  const refused = (st: RowStep) => mine(st) && failed.has(st.ref);
  expect(
    sortedDistinct(after.steps.filter((st) => !refused(st))),
    `${at}: the other steps`,
  ).toEqual(sortedDistinct(before.steps.filter((st) => !refused(st))));
  for (const ref of failed)
    expect(
      sortedDistinct(after.steps.filter((st) => mine(st) && st.ref === ref)).map((st) => ({
        outcome: st.outcome,
        reason: st.reason,
      })),
      `${at}: ${ref} says`,
    ).toEqual([{ outcome: "unknown", reason: { reason: "failed" } }]);

  for (const [q, answer] of Object.entries(was.providers))
    if (q !== id) expect(now.providers[q], `${at}: ${q}`).toEqual(answer);
  const own = was.providers[id] as NormalProvider | undefined;
  const got = now.providers[id];
  if (failed.size === 0) expect(got, `${at}: ${id}`).toEqual(own);
  else if (own) {
    const left = own.rows.filter((r) => !failed.has((r as { readonly ref: string }).ref));
    expect(got?.rows, `${at}: ${id}'s rows`).toEqual(left);
    expect(got?.outcome, `${at}: ${id}'s outcome`).toBe(left.length > 0 ? "found" : "unknown");
    expect(got?.unknown, `${at}: ${id}'s reasons`).toEqual(
      sortedDistinct([...own.unknown, { reason: "failed" }]),
    );
  }
  return failed;
}

// ---------------------------------------------------------------- the properties

describe("fields", () => {
  property(
    "schemas that accept every value change nothing under strict, as they answer at once or later",
    timed,
    async (s) => {
      const strict = (fields?: Fields) =>
        playAll(s, s.timing[0], undefined, "plan", {
          validate: "strict",
          ...(fields ? { fields } : {}),
        });
      const [bare, sync, later] = await Promise.all([
        strict(),
        strict(accepting("sync", s.timing[1])),
        strict(accepting("async", s.timing[1])),
      ]);
      expectSame(bare, sync, "synchronous schemas");
      expectSame(bare, later, "asynchronous schemas");
    },
  );

  property(
    "schemas that reject every value change nothing where the run does not validate strictly",
    fc.record({ s: timed, validate: fc.constantFrom("boundaries" as const, "off" as const) }),
    async ({ s, validate }) => {
      const [bare, rejected] = await Promise.all([
        playAll(s, s.timing[0], undefined, "plan", { validate }),
        playAll(s, s.timing[0], undefined, "plan", { validate, fields: rejecting(s.timing[1]) }),
      ]);
      expectSame(bare, rejected, `${validate}, every field rejecting`);
    },
  );

  property(
    "a strict run fails the refs whose rows hold a field that rejects its values, and no other",
    rejections,
    async (c) => {
      try {
        await rejectOne(c);
      } catch (error) {
        refuted = true;
        throw error;
      }
    },
  );

  // what the property above is about happened, or it passed by never meeting it
  it("met a field that rejected rows", () => {
    if (ran && !refuted) expect(met).toBeGreaterThan(0);
  });
});
