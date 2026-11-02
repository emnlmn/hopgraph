// Providers (DESIGN.md §3.5, §5.5): a provider's loader value per key, projected into rows. Each
// row keeps the raw fields the provider declares and adds its derived fields, each computed from
// exactly its inputs. A provider is evaluated once per ref per run, refs of one key that agree on
// what its loader reads being one.

import type { Attrs, ProviderDef } from "../core/index.ts";
import { capped, notRead, tighter, withinRefs } from "./caps.ts";
import type { KeyAnswer } from "./envelope.ts";
import type { Hydration } from "./hydration.ts";
import { type ProviderAnswer, recordOf, type Said, saidOf, say, tallyOf } from "./ledger.ts";
import { Memo, Memoized } from "./memo.ts";
import { identity, type RefNode } from "./refs.ts";
import type { Lane } from "./schedule.ts";
import { answerOf, loaderOf, type StepContext, statsOf, timedRead } from "./step.ts";

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
    const answers = new Map<string, ProviderAnswer>();
    const said: Said[] = [];
    for (const ref of refs) {
      const refusal = refused.get(ref.id);
      const projected = refusal
        ? { said: refusal, rows: [] }
        : rowsOf(provider, ref, answerOf(read, ref), most);
      said.push(projected.said);
      answers.set(keyOf(ref), {
        rows: projected.rows,
        tally: tallyOf(projected.said),
        steps: [recordOf(step, loader.id, ref, projected.said)],
      });
    }
    this.ctx.trace.record(step, loader.id, statsOf(refs.length, read), said);
    // the refs past the cap: not read, cut, each with its row step
    for (const { ref, record } of notRead(this.ctx, step, loader.id, past))
      answers.set(keyOf(ref), { rows: [], tally: tallyOf(record), steps: [record] });
    return answers;
  }
}

/** A ref's rows, the first `most` of them, cut past it. */
function rowsOf(
  provider: ProviderDef<unknown>,
  ref: RefNode,
  answer: KeyAnswer,
  most: number | undefined,
): { readonly said: Said; readonly rows: readonly Attrs[] } {
  if (answer.kind !== "found") return { said: saidOf(answer), rows: [] };
  const projected = provider.project(answer.value, ref.key);
  const over = most !== undefined && projected.length > most;
  const rows = (over ? projected.slice(0, most) : projected).map((row) => fieldsOf(provider, row));
  const cuts = over ? [...answer.cuts, capped("rows", most)] : answer.cuts;
  // a value that projects to no row is an absence, still cut when its source was
  const said =
    rows.length > 0 ? say.found(cuts, answer.coverage) : say.absent(answer.coverage, cuts);
  return { said, rows };
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
