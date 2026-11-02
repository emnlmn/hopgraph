import { describe, expect, it } from "vitest";
import { CostChangedError } from "../../core/index.ts";
import { Approvals, decide, Gates } from "../gates.ts";
import { gateId, keyToken, scopeKey } from "../ids.ts";
import { MemoryCache } from "./support.ts";

const CAPS = { auto: 1e9, approve: 1e11 };

describe("decide", () => {
  it("runs under auto with the price as budget, gates up to approve, refuses above it", () => {
    expect(decide(CAPS, 5e8, "g", undefined)).toEqual({ kind: "run", maxBytes: 5e8 });
    expect(decide(CAPS, 5e9, "g", undefined)).toEqual({ kind: "gate" });
    expect(decide(CAPS, 1e11, "g", undefined)).toEqual({ kind: "gate" });
    expect(decide(CAPS, 2e11, "g", undefined)).toEqual({ kind: "too_heavy" });
  });

  it("an approval runs with the approval as budget, even when the price shrank", () => {
    expect(decide(CAPS, 5e9, "g", 5e9)).toEqual({ kind: "run", maxBytes: 5e9 });
    expect(decide(CAPS, 3e8, "g", 5e9)).toEqual({ kind: "run", maxBytes: 5e9 });
  });

  it("a price grown past its approval throws before anything runs", () => {
    expect(() => decide(CAPS, 6e9, "g", 5e9)).toThrow(CostChangedError);
    expect(() => decide(CAPS, 6e9, "g", 5e9)).toThrow(
      expect.objectContaining({ gate: "g", approved: 5e9, priced: 6e9 }),
    );
  });

  it("an approval above the approve cap never lifts it", () => {
    expect(decide(CAPS, 2e11, "g", 5e11)).toEqual({ kind: "too_heavy" });
    expect(decide(CAPS, 5e10, "g", 5e11)).toEqual({ kind: "run", maxBytes: 1e11 });
  });
});

describe("Gates", () => {
  it("keeps each gate once", () => {
    const gates = new Gates();
    const gate = { id: "g", step: "s", loader: "l", keys: 1, bytes: 2 };
    expect(gates.add(gate)).toBe(true);
    expect(gates.add({ ...gate, bytes: 3 })).toBe(false);
    expect(gates.list()).toEqual([gate]);
  });
});

describe("Approvals", () => {
  const scans = { id: "scans", version: 1 };
  const token = (key: string) => keyToken(scans, "r", key, key, "{}");
  const p1 = token("p1");
  const p2 = token("p2");
  const p3 = token("p3");
  const p4 = token("p4");
  const gate = gateId(scans, "r", [p1, p2, p3]);

  /** A gated run remembered `gate` over p1, p2, p3 in `cache`; the next one approves it. */
  async function approved(bytes: number, cache = new MemoryCache()) {
    await new Approvals({}, cache).remember(gate, [p1, p2, p3]);
    return new Approvals({ [gate]: bytes }, cache);
  }

  it("an approval covers its own gate id exactly", async () => {
    const approvals = await approved(5e9);
    expect(approvals.exact(gate)).toBe(5e9);
    expect(approvals.exact(gateId(scans, "r", [p1]))).toBeUndefined();
  });

  it("covers a later request for a subset of its keys at no higher price, and spends it", async () => {
    const approvals = await approved(5e9);
    expect(await approvals.cover(scans, [p1], 2e9)).toBe(true);
    // what is left of it: 3e9
    expect(await approvals.cover(scans, [p2, p3], 4e9)).toBe(false);
    expect(await approvals.cover(scans, [p2, p3], 3e9)).toBe(true);
    expect(await approvals.cover(scans, [p2], 1)).toBe(false);
  });

  it("never covers a key outside it, another loader's keys, or a gate whose scope the cache lost", async () => {
    const approvals = await approved(5e9);
    expect(await approvals.cover(scans, [p1, p4], 1)).toBe(false);
    expect(await approvals.cover({ id: "other" }, [p1], 1)).toBe(false);
    const forgotten = new Approvals({ [gate]: 5e9 }, new MemoryCache());
    expect(await forgotten.cover(scans, [p1], 1)).toBe(false);
  });

  it("reads the scopes it needs once per run, and an entry it did not write is no scope", async () => {
    const cache = new MemoryCache();
    cache.store.set(scopeKey(gate), { kind: "found", value: { tokens: [p1] } });
    const approvals = new Approvals({ [gate]: 5e9, "other:x": 1 }, cache);
    expect(await approvals.cover(scans, [p1], 1)).toBe(false);
    expect(await approvals.cover(scans, [p1], 1)).toBe(false);
    expect(cache.gets).toEqual([[scopeKey(gate), scopeKey("other:x")]]);
  });
});
