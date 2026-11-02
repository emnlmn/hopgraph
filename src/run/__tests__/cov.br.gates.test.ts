// Approvals that cover a later request: the order they are spent in does not depend on the order
// they were given in.

import { expect, it } from "vitest";
import { Approvals } from "../gates.ts";
import { gateId, keyToken } from "../ids.ts";
import { MemoryCache } from "./support.ts";

it("of two approvals that cover the keys, given lowest id first, the lowest is still spent first", async () => {
  const scans = { id: "scans", version: 1 };
  const token = (key: string) => keyToken(scans, "r", key, key, "{}");
  const [p1, p2, p3] = [token("p1"), token("p2"), token("p3")];
  const cache = new MemoryCache();
  const first = gateId(scans, "r", [p1, p2]);
  const second = gateId(scans, "r", [p1, p3]);
  const [lower, higher] = [first, second].sort() as [string, string];
  await new Approvals({}, cache).remember(first, [p1, p2]);
  await new Approvals({}, cache).remember(second, [p1, p3]);
  // given lowest id first, with the smaller amount
  const approvals = new Approvals({ [lower]: 1e9, [higher]: 2e9 }, cache);

  // the lower id covers first and is spent; the higher then covers what the lower cannot
  expect(await approvals.cover(scans, [p1], 1e9)).toBe(true);
  expect(await approvals.cover(scans, [p1], 2e9)).toBe(true);
  expect(await approvals.cover(scans, [p1], 1)).toBe(false);
});
