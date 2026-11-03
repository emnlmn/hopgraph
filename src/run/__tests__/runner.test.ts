// The store a runner given no cache keeps (run/cache.ts `gateScopes`): the scopes of the gates its
// runs stop at, each for the hour it is written for, and nothing else.

import { describe, expect, it } from "vitest";
import { gateScopes } from "../cache.ts";
import { scopeKey } from "../ids.ts";
import type { CachedAnswer } from "../types.ts";

const SCOPE: CachedAnswer = { kind: "found", value: ["t1", "t2"] };
const HOUR = 3_600_000;

describe("a runner's gate scopes", () => {
  it("keep a gate's scope for an hour from when it was written, and no longer", async () => {
    let now = 0;
    const store = gateScopes(() => now);
    const key = scopeKey("totals:abc");
    await store.setMany([{ key, answer: SCOPE, retention: "hour" }]);

    now = HOUR - 1;
    expect(await store.getMany([key])).toEqual(new Map([[key, SCOPE]]));
    now = HOUR;
    expect(await store.getMany([key])).toEqual(new Map());
  });

  it("keep nothing but scopes: an answer is read again", async () => {
    const store = gateScopes(() => 0);
    const answer = "hopgraph:1:answer:totals:1:abc";
    await store.setMany([{ key: answer, answer: SCOPE, retention: "hour" }]);

    expect(await store.getMany([answer])).toEqual(new Map());
  });

  it("hold a bounded number, the oldest dropped first", async () => {
    const store = gateScopes(() => 0, 2);
    const [a, b, c] = ["a", "b", "c"].map((id) => scopeKey(`totals:${id}`)) as [
      string,
      string,
      string,
    ];
    for (const key of [a, b, c]) await store.setMany([{ key, answer: SCOPE, retention: "hour" }]);

    expect([...(await store.getMany([a, b, c])).keys()]).toEqual([b, c]);
  });
});
