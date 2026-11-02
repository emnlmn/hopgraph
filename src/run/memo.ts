// Answers shared by every step of a run. The first to ask for a key claims it and settles it; who
// asks later, or meanwhile, waits for that answer instead of computing it again. This is what makes
// a prefix shared by two routes, or a loader shared by a hydrator, a relation and a provider, read
// once.

import { HopgraphError } from "../core/index.ts";

interface Entry<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  settled?: { readonly value: T };
}

function pending<T>(): Entry<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // a failed key nobody waits for must not surface as an unhandled rejection
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export class Memo<T extends object> {
  private readonly entries = new Map<string, Entry<T>>();

  /** True when the key was free: it is now the caller's to settle, or to fail. */
  claim(key: string): boolean {
    if (this.entries.has(key)) return false;
    this.entries.set(key, pending<T>());
    return true;
  }

  settle(key: string, value: T): void {
    const entry = this.entries.get(key);
    if (!entry || entry.settled) return;
    entry.settled = { value };
    entry.resolve(value);
  }

  /** Fails the keys not settled yet: whoever waits for them gets the error. */
  fail(keys: Iterable<string>, error: unknown): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && !entry.settled) entry.reject(error);
    }
  }

  wait(key: string): Promise<T> {
    const entry = this.entries.get(key);
    return entry
      ? entry.promise
      : Promise.reject(new HopgraphError("HG_INTERNAL", "no step claimed this key"));
  }

  /** The answer of a key once it is settled. */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.settled?.value;
  }

  /**
   * Every item's answer: the items nobody claimed yet are computed together by `compute` and shared
   * from then on; the others are awaited.
   */
  async resolve<I>(
    items: readonly I[],
    keyOf: (item: I) => string,
    compute: (claimed: readonly I[]) => Promise<ReadonlyMap<string, T>>,
  ): Promise<Map<string, T>> {
    const claimed = items.filter((item) => this.claim(keyOf(item)));
    if (claimed.length > 0) {
      const keys = claimed.map(keyOf);
      try {
        const values = await compute(claimed);
        for (const key of keys) {
          const value = values.get(key);
          if (value === undefined)
            throw new HopgraphError("HG_INTERNAL", "a step left one of its keys unanswered");
          this.settle(key, value);
        }
      } catch (error) {
        this.fail(keys, error);
        throw error;
      }
    }
    const answers = new Map<string, T>();
    for (const item of items) answers.set(keyOf(item), await this.wait(keyOf(item)));
    return answers;
  }
}
