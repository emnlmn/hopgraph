// Runs the playlist example twice through examples/metrics.ts, over one cache: the first run loads
// every key, the second finds them all in the cache.

import { memoryCache } from "hopgraph";
import { describe, expect, it } from "vitest";
import { metrics } from "./metrics.ts";
import { example } from "./playlist.ts";

describe("examples/metrics", () => {
  it("keeps each loader's jobs, keys, cache hits, calls and time; the hit ratio rises once the cache is warm", async () => {
    const cache = memoryCache();
    const cold = metrics();
    await example({ tracer: cold.tracer, cache });

    expect(cold.loaders.get("artists")).toMatchObject({
      jobs: 1,
      keys: 3,
      hits: 0,
      calls: 2,
      attempts: 2,
      retries: 0,
      billedBytes: 0,
      circuits: { closed: 2, "half-open": 0, open: 0 },
    });
    expect(cold.loaders.get("artists")?.ms).toBeGreaterThanOrEqual(0);
    expect(cold.hitRatio("artists")).toBe(0);
    // the label service is switched off: no job, no metrics
    expect(cold.loaders.has("labels")).toBe(false);

    const warm = metrics();
    await example({ tracer: warm.tracer, cache });
    expect(warm.loaders.get("artists")).toMatchObject({ jobs: 1, keys: 3, hits: 3, calls: 0 });
    expect(warm.hitRatio("artists")).toBe(1);
  });
});
