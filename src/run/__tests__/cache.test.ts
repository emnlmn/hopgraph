// `memoryCache`, the port a consumer takes for tests, prototypes and single-process apps: each
// retention's time to live, what an expired entry does, and which entry goes first past `max`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCache } from "../cache.ts";
import type { CachedAnswer, CachePort } from "../types.ts";

const ANSWER: CachedAnswer = { kind: "found", value: 1 };
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Retention = Parameters<CachePort["setMany"]>[0][number]["retention"];

const write = (cache: CachePort, key: string, retention: Retention = "day") =>
  cache.setMany([{ key, answer: ANSWER, retention }]);
const read = async (cache: CachePort, ...keys: string[]) => [...(await cache.getMany(keys)).keys()];

afterEach(() => vi.useRealTimers());

describe("memoryCache", () => {
  it("keeps an answer for the time of its retention, and no longer", async () => {
    let now = 0;
    const cache = memoryCache({ clock: () => now });
    for (const retention of ["day", "hour", "brief"] as const)
      await write(cache, retention, retention);

    now = MINUTE - 1;
    expect(await read(cache, "day", "hour", "brief")).toEqual(["day", "hour", "brief"]);
    now = MINUTE;
    expect(await read(cache, "day", "hour", "brief")).toEqual(["day", "hour"]);
    now = HOUR;
    expect(await read(cache, "day", "hour", "brief")).toEqual(["day"]);
    now = DAY;
    expect(await read(cache, "day", "hour", "brief")).toEqual([]);
  });

  it("takes the time of a retention given, and the default of the others", async () => {
    let now = 0;
    const cache = memoryCache({ ttl: { hour: 10 }, clock: () => now });
    for (const retention of ["day", "hour", "brief"] as const)
      await write(cache, retention, retention);

    now = 10;
    expect(await read(cache, "day", "hour", "brief")).toEqual(["day", "brief"]);
    now = MINUTE;
    expect(await read(cache, "day", "hour", "brief")).toEqual(["day"]);
  });

  it("reads the time from Date.now unless it is given a clock", async () => {
    vi.useFakeTimers();
    const cache = memoryCache();
    await write(cache, "k", "brief");

    vi.advanceTimersByTime(MINUTE - 1);
    expect(await read(cache, "k")).toEqual(["k"]);
    vi.advanceTimersByTime(1);
    expect(await read(cache, "k")).toEqual([]);
  });

  it("leaves out a key it does not have", async () => {
    const cache = memoryCache();
    await write(cache, "a");

    expect(await cache.getMany(["a", "b"])).toEqual(new Map([["a", ANSWER]]));
    expect(await cache.getMany([])).toEqual(new Map());
  });

  it("drops an expired entry when a read meets it: it does not come back", async () => {
    let now = 0;
    const cache = memoryCache({ clock: () => now });
    await write(cache, "k", "brief");

    now = MINUTE;
    expect(await read(cache, "k")).toEqual([]);
    now = 0;
    expect(await read(cache, "k")).toEqual([]);
  });

  it("drops the expired entries when it writes, before it counts them against `max`", async () => {
    let now = 0;
    const cache = memoryCache({ max: 2, clock: () => now });
    await write(cache, "short", "brief");
    await write(cache, "long", "day");

    now = MINUTE;
    await write(cache, "new", "day");
    expect(await read(cache, "short", "long", "new")).toEqual(["long", "new"]);
    now = 0;
    expect(await read(cache, "short")).toEqual([]);
  });

  it("drops the oldest written past `max`, and 10 000 entries unless told", async () => {
    const small = memoryCache({ max: 2 });
    for (const key of ["a", "b", "c"]) await write(small, key);
    expect(await read(small, "a", "b", "c")).toEqual(["b", "c"]);

    const large = memoryCache();
    await large.setMany(
      Array.from({ length: 10_001 }, (_, i) => ({
        key: `k${i}`,
        answer: ANSWER,
        retention: "day" as const,
      })),
    );
    expect(await read(large, "k0", "k1", "k10000")).toEqual(["k1", "k10000"]);
  });

  it("drops the oldest written past `max` whatever its retention", async () => {
    const cache = memoryCache({ max: 2 });
    await write(cache, "a", "hour");
    await write(cache, "b", "brief");
    await write(cache, "c", "day");
    expect(await read(cache, "a", "b", "c")).toEqual(["b", "c"]);
    await write(cache, "d", "hour");
    expect(await read(cache, "b", "c", "d")).toEqual(["c", "d"]);
  });

  it("drops an expired entry when it writes, whichever queue holds it", async () => {
    let now = 0;
    const cache = memoryCache({ max: 2, clock: () => now });
    await write(cache, "long", "day");
    await write(cache, "mid", "hour");
    now = HOUR;
    // `mid` expired behind a live `long`: the write drops it, so `long` stays within `max`
    await write(cache, "new", "brief");
    expect(await read(cache, "long", "mid", "new")).toEqual(["long", "new"]);
  });

  it("makes a key written again the newest, with its own time", async () => {
    let now = 0;
    const cache = memoryCache({ max: 2, clock: () => now });
    await write(cache, "a", "brief");
    await write(cache, "b");
    now = 1;
    await write(cache, "a");
    await write(cache, "c");

    expect(await read(cache, "a", "b", "c")).toEqual(["a", "c"]);
    now = MINUTE;
    expect(await read(cache, "a", "c")).toEqual(["a", "c"]);
  });
});
