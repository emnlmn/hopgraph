// Providers (DESIGN.md §3.5, §5.5): a provider's loader value per key, projected into rows. Each
// row keeps the raw fields the provider declares and adds its derived fields, each computed from
// exactly its inputs. A provider is evaluated once per ref per run, refs of one key that agree on
// what its loader reads being one.
//
// A strict run also checks the rows a ref keeps against their fields' schemas (DESIGN.md §5.6): the
// raw values as projected, the derived ones as computed from the parsed raw ones. A ref with a value
// that fails is unknown `failed`, with no rows: a ref told "found" with a row missing would claim
// more than was read. The loader's answer is cached as it came; the check is on the projection.

import type { Attrs, ProviderDef } from "../core/index.ts";
import { capped, notRead, tighter, withinRefs } from "./caps.ts";
import type { KeyAnswer } from "./envelope.ts";
import { type ProviderAnswer, recordOf, type Said, saidOf, say, tallyOf } from "./ledger.ts";
import { Memo, Memoized } from "./memo.ts";
import { identity, type RefNode } from "./refs.ts";
import type { Lane } from "./schedule.ts";
import { answerOf, loaderOf, statsOf, timedRead } from "./step.ts";
import { validFields } from "./validate.ts";

/** What a provider says of a ref, and its rows. */
interface Projected {
  readonly said: Said;
  readonly rows: readonly Attrs[];
}

/** A provider's answer for a ref with a row whose values failed their fields' schemas. */
const INVALID: Projected = { said: say.unknown({ reason: "failed" }), rows: [] };

export class Providers extends Memoized<ProviderAnswer> {
  evaluate(
    lane: Lane,
    provider: ProviderDef<unknown>,
    refs: readonly RefNode[],
  ): Promise<ReadonlyMap<string, ProviderAnswer>> {
    // a provider is one plan node, evaluated once per run: its attributes and memo are new here
    const loader = loaderOf(this.ctx.graph, provider.loader);
    const attrs = [...new Set([...loader.needs, ...loader.hints])].sort();
    this.attrs.set(provider.id, attrs);
    const memo = new Memo<ProviderAnswer>();
    this.memos.set(provider.id, memo);
    const keyOf = (ref: RefNode) => identity(ref, attrs);
    return memo.resolve(refs, keyOf, (claimed) => this.compute(lane, provider, claimed, keyOf));
  }

  /** Offers refs that reached a node still waiting for its other inputs to its loader's jobs of
   *  waves after `wave`. */
  anticipate(
    node: string,
    provider: ProviderDef<unknown>,
    refs: readonly RefNode[],
    wave: number,
  ): void {
    // under a refs cap a step reads only its own refs, which it knows once every input is in
    if (this.ctx.caps.refs !== undefined) return;
    const loader = loaderOf(this.ctx.graph, provider.loader);
    this.ctx.reads.anticipate(node, `provider:${provider.id}`, loader, refs, loader.needs, wave);
  }

  answer(provider: string, ref: RefNode): ProviderAnswer | undefined {
    return this.peek(provider, ref);
  }

  private async compute(
    lane: Lane,
    provider: ProviderDef<unknown>,
    all: readonly RefNode[],
    keyOf: (ref: RefNode) => string,
  ): Promise<Map<string, ProviderAnswer>> {
    // refs past the run's cap are not read: cut, never absent
    const { read: refs, past } = withinRefs(all, this.ctx.caps.refs);
    const most = tighter(this.ctx.caps.rows, provider.caps.rows);
    const step = `provider:${provider.id}`;
    const loader = loaderOf(this.ctx.graph, provider.loader);
    const { ready, refused } = await this.hydration.prepare(
      lane,
      provider.entity,
      refs,
      loader.needs,
    );
    const read = await timedRead(this.ctx, lane, step, loader, ready);
    const projected = refs.map((ref) => {
      const refusal = refused.get(ref.id);
      const p: Projected = refusal
        ? { said: refusal, rows: [] }
        : rowsOf(provider, ref, answerOf(read, ref), most);
      return [ref, p] as const;
    });
    // no `reads.busy`: nothing reads after a provider, so its schemas can add no key to a job
    const answered =
      this.ctx.validate === "strict"
        ? await Promise.all(
            projected.map(async ([ref, p]) => [ref, await withCheckedFields(provider, p)] as const),
          )
        : projected.map(([ref, p]) => [ref, withFields(provider, p)] as const);
    const answers = new Map<string, ProviderAnswer>();
    for (const [ref, { said, rows }] of answered)
      answers.set(keyOf(ref), {
        rows,
        tally: tallyOf(said),
        steps: [recordOf(step, loader.id, ref, said)],
      });
    const invalid = answered.filter(([, p]) => p === INVALID).length;
    const said = answered.map(([, p]) => p.said);
    this.ctx.trace.record(step, loader.id, statsOf(refs.length, read, invalid), said);
    // the refs past the cap: not read, cut, each with its row step
    for (const { ref, record } of notRead(this.ctx, step, loader.id, past))
      answers.set(keyOf(ref), { rows: [], tally: tallyOf(record), steps: [record] });
    return answers;
  }
}

/** A ref's rows as the provider projects them, the first `most` of them, cut past it. */
function rowsOf(
  provider: ProviderDef<unknown>,
  ref: RefNode,
  answer: KeyAnswer,
  most: number | undefined,
): Projected {
  if (answer.kind !== "found") return { said: saidOf(answer), rows: [] };
  const projected = provider.project(answer.value, ref.key);
  const over = most !== undefined && projected.length > most;
  const rows = over ? projected.slice(0, most) : projected;
  const cuts = over ? [...answer.cuts, capped("rows", most)] : answer.cuts;
  // a value that projects to no row is an absence, still cut when its source was
  const said =
    rows.length > 0 ? say.found(cuts, answer.coverage) : say.absent(answer.coverage, cuts);
  return { said, rows };
}

/** A ref's rows with their fields. */
function withFields(provider: ProviderDef<unknown>, { said, rows }: Projected): Projected {
  return { said, rows: rows.map((row) => fieldsOf(provider, row)) };
}

/** A ref's rows with their fields, as the fields' schemas parse them; `INVALID` when a value of
 *  one of them fails. The rows are those the cap kept: a row it cut is not answered, so not
 *  checked. */
async function withCheckedFields(
  provider: ProviderDef<unknown>,
  { said, rows }: Projected,
): Promise<Projected> {
  const checked = await Promise.all(rows.map((row) => checkedFieldsOf(provider, row)));
  return checked.every((row) => row !== undefined) ? { said, rows: checked } : INVALID;
}

/** A row's fields as their schemas parse them, the derived ones computed from the parsed raw ones;
 *  `undefined` when one fails. */
async function checkedFieldsOf(
  provider: ProviderDef<unknown>,
  row: Attrs,
): Promise<Attrs | undefined> {
  const raw = await validFields(provider.raw, row);
  return raw && validFields(provider.derived, fieldsOf(provider, raw));
}

/** The raw fields the provider declares, then its derived ones, each fed exactly its inputs. */
function fieldsOf(provider: ProviderDef<unknown>, row: Attrs): Attrs {
  const fields: Record<string, unknown> = {};
  for (const name of Object.keys(provider.raw))
    if (Object.hasOwn(row, name)) fields[name] = row[name];
  for (const [name, field] of Object.entries(provider.derived)) {
    const inputs = Object.fromEntries(field.inputs.map((input) => [input, row[input]]));
    fields[name] = field.compute(inputs);
  }
  return fields;
}
