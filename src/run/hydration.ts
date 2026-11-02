// Hydration (DESIGN.md §3.2): before a step that needs carried attributes, the refs whose given
// values lack one get them from their entity's hydrator, read by key (never for a context
// attribute, which only a base row or a link brings). What came with the base row or the reaching
// link wins over it. A ref the step still cannot take is refused: absent when the hydrator found no
// such key (nothing can be read through a key that does not exist), unknown `unmet` when a need is
// missing for any other reason, never absent. What the hydrator projects is checked against the
// entity's schemas unless the run validates nothing: a key whose attributes fail is unknown
// `failed`, so its dependent steps are unmet.
//
// Every step reads the hydrator for the keys it lacks itself, even a key another step hydrated
// already (the run's answers serve it, and nothing is loaded twice): the read takes a wave, and the
// waves of the step's later reads must not depend on which step came first (schedule.ts). A key's
// hydration is recorded once (what it teaches the key's refs, its row step, its trace) by the step
// that asked for it in the earliest wave, so what the record says, cached or loaded, does not
// depend on which read ended first either. The other steps wait until it is recorded.

import { FAILED, type KeyAnswer } from "./envelope.ts";
import { recordOf, type Said, type StepRecord, saidOf, say } from "./ledger.ts";
import { keyText, type RefId, type RefNode } from "./refs.ts";
import type { Lane } from "./schedule.ts";
import { answerOf, loaderOf, type StepContext, statsOf, timedRead } from "./step.ts";
import { validCarried } from "./validate.ts";

export interface Prepared {
  /** the refs that have every need */
  readonly ready: readonly RefNode[];
  /** per ref id, what the step says of a ref it cannot take */
  readonly refused: ReadonlyMap<string, Said>;
}

interface Hydrated {
  readonly answer: KeyAnswer;
  /** the hydration's own row step */
  readonly record: StepRecord;
}

/** A key's hydration until it is recorded: the earliest wave a step asked for it in. */
interface Pending {
  wave: number;
  /** a read of that wave is recording it */
  taken: boolean;
  readonly recorded: Promise<void>;
  readonly done: () => void;
}

export class Hydration {
  /** per key, once recorded */
  private readonly hydrated = new Map<string, Hydrated>();
  /** per key, from the first step that asked for it */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ctx: StepContext) {}

  async prepare(
    lane: Lane,
    entity: string,
    refs: readonly RefNode[],
    needs: readonly string[],
  ): Promise<Prepared> {
    const lacking = refs.filter((ref) => this.ctx.refs.lacks(ref, needs));
    if (lacking.length > 0) await this.hydrate(lane, entity, lacking);
    const ready: RefNode[] = [];
    const refused = new Map<string, Said>();
    for (const ref of refs) {
      const missing = this.ctx.refs.missing(ref, needs);
      if (missing.length === 0) ready.push(ref);
      else refused.set(ref.id, this.refusal(ref, missing));
    }
    return { ready, refused };
  }

  record(ref: RefId): StepRecord | undefined {
    return this.hydrated.get(keyText(ref))?.record;
  }

  private refusal(ref: RefId, missing: readonly string[]): Said {
    const answer = this.hydrated.get(keyText(ref))?.answer;
    return answer?.kind === "absent" ? say.absent(answer.coverage) : say.unmet(missing);
  }

  private async hydrate(lane: Lane, entity: string, refs: readonly RefNode[]): Promise<void> {
    const hydrator = this.ctx.graph.hydrators.get(entity);
    // the graph test flags needed attributes without a hydrator; at run time they stay unmet
    if (!hydrator) return;
    const step = `hydrate:${entity}`;
    const loader = loaderOf(this.ctx.graph, hydrator.loader);
    // the hydrator reads by key alone: one ref per key
    const perKey = [...new Map(refs.map((ref) => [keyText(ref), ref])).values()];
    const wave = lane.wave + 1;
    for (const ref of perKey) this.ask(keyText(ref), wave);
    const read = await timedRead(this.ctx, lane, step, loader, perKey);

    // the keys this read records: asked in no earlier wave, and not taken by a read of this one
    const mine = perKey.filter((ref) => {
      const pending = this.pending.get(keyText(ref));
      if (!pending || pending.taken || pending.wave !== wave) return false;
      pending.taken = true;
      return true;
    });
    const def = this.ctx.graph.entities[entity];
    // a validator may be asynchronous: until the attributes are checked, the lane is busy
    const learned = await this.ctx.reads.busy(
      lane,
      Promise.all(
        mine.map(async (ref) => {
          const answer = answerOf(read, ref);
          if (answer.kind !== "found") return undefined;
          const attrs = hydrator.project(answer.value);
          return this.ctx.validate === "off" || !def ? attrs : validCarried(def, attrs);
        }),
      ),
    );
    let invalid = 0;
    const said: StepRecord[] = [];
    mine.forEach((ref, i) => {
      let answer = answerOf(read, ref);
      const attrs = learned[i];
      if (answer.kind === "found" && attrs) this.ctx.refs.learn(ref, attrs);
      else if (answer.kind === "found") {
        answer = FAILED;
        invalid += 1;
      }
      const record = recordOf(step, loader.id, ref, saidOf(answer));
      this.hydrated.set(keyText(ref), { answer, record });
      said.push(record);
      this.pending.get(keyText(ref))?.done();
    });
    // the keys it records, and its read's bill and failures, even when another read records
    // every one of its keys
    const cached = mine.filter(
      (ref) => answerOf(read, ref).kind !== "unknown" && !read.loaded.has(ref.id),
    ).length;
    this.ctx.trace.record(
      step,
      loader.id,
      statsOf(mine.length, { ...read, cached }, invalid),
      said,
    );
    // the keys another read records: learned once it has
    const others = perKey.flatMap((ref) =>
      this.hydrated.has(keyText(ref)) ? [] : [this.pending.get(keyText(ref))?.recorded],
    );
    if (others.length > 0) await this.ctx.reads.busy(lane, Promise.all(others));
  }

  /** A step asks for a key's hydration in `wave`. */
  private ask(key: string, wave: number): void {
    const pending = this.pending.get(key);
    if (pending) {
      if (!pending.taken) pending.wave = Math.min(pending.wave, wave);
      return;
    }
    let done: () => void = () => undefined;
    const recorded = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.pending.set(key, { wave, taken: false, recorded, done });
  }
}
