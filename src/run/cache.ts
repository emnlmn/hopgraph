// The caches the library makes: `memoryCache`, a `CachePort` in the process's memory for tests,
// prototypes and single-process applications, and `gateScopes`, what a runner given no cache keeps
// (DESIGN.md §5.9).

import { isScopeKey } from "./ids.ts";
import type { CachedAnswer, CachePort } from "./types.ts";

/** What `memoryCache` takes. */
export interface MemoryCacheOptions {
  /** the most entries it holds. Default: 10 000 */
  readonly max?: number;
  /** how long each retention keeps an answer, in ms. Default: `day` 86 400 000, `hour` 3 600 000,
   *  `brief` 60 000 */
  readonly ttl?: Partial<Record<"day" | "hour" | "brief", number>>;
  /** the time each `ttl` is measured against, in epoch ms. Default: `Date.now` */
  readonly clock?: () => number;
}

const TTL = { day: 86_400_000, hour: 3_600_000, brief: 60_000 };

/**
 * Cache answers in memory, for tests, prototypes and single-process apps. An app with several
 * processes supplies its own port (Redis, a framework cache), so that they share what they read.
 * Each retention keeps an answer for its `ttl`, and a read that meets an expired one drops it. Past
 * `max` entries the oldest written is dropped first, and a key written again is the newest. A read
 * costs its keys and a write the entries it writes and drops: neither walks the whole cache.
 */
export function memoryCache(options: MemoryCacheOptions = {}): CachePort {
  const { max = 10_000, clock = Date.now } = options;
  const ttl = { ...TTL, ...options.ttl };
  // One queue per retention, in the order its entries were written. A retention's ttl is fixed, so
  // a queue is also in the order its entries expire: expiry stops at the first live entry, and the
  // oldest written is one of three heads. A clock that steps back leaves an expired entry behind a
  // live one, until a read meets it or it is the oldest.
  const queues = {
    day: new Map<string, Entry>(),
    hour: new Map<string, Entry>(),
    brief: new Map<string, Entry>(),
  };
  const all = Object.values(queues);
  let written = 0;
  return {
    getMany: async (keys) => {
      const now = clock();
      const hits = new Map<string, CachedAnswer>();
      for (const key of keys)
        for (const queue of all) {
          const entry = queue.get(key);
          if (!entry) continue;
          if (entry.until > now) hits.set(key, entry.answer);
          else queue.delete(key);
          break;
        }
      return hits;
    },
    setMany: async (entries) => {
      const now = clock();
      for (const queue of all)
        for (const [key, entry] of queue) {
          if (entry.until > now) break;
          queue.delete(key);
        }
      for (const { key, answer, retention } of entries) {
        // written again, it is the newest
        for (const queue of all) queue.delete(key);
        queues[retention].set(key, { answer, until: now + ttl[retention], seq: written++ });
      }
      while (queues.day.size + queues.hour.size + queues.brief.size > max) {
        const heads = all.flatMap((queue) => {
          const head = queue.entries().next();
          return head.done ? [] : [{ queue, key: head.value[0], seq: head.value[1].seq }];
        });
        const oldest = heads.reduce((a, b) => (b.seq < a.seq ? b : a));
        oldest.queue.delete(oldest.key);
      }
    },
  };
}

/** An answer as `memoryCache` keeps it. */
interface Entry {
  readonly answer: CachedAnswer;
  /** when it expires, in epoch ms */
  readonly until: number;
  /** its place in the order of writes, across the queues */
  readonly seq: number;
}

/**
 * The cache of a runner given none: the scopes of the gates its runs stop at, for the hour each is
 * written for, and nothing else, so every call still reads its sources. Without them an approval
 * would cover its own gate id only, and a resume whose keys came in parts (another call loading
 * some of them) would stop at a gate of its own. It holds `most` scopes at a time, the oldest
 * dropped first (an approval of a dropped one covers its own gate id only), and lets an expired one
 * go whenever it meets it.
 */
export function gateScopes(clock: () => number, most = 10_000): CachePort {
  const kept = memoryCache({ max: most, clock });
  return {
    getMany: kept.getMany,
    setMany: (entries) =>
      kept.setMany(entries.filter((e) => isScopeKey(e.key) && e.retention === "hour")),
  };
}
