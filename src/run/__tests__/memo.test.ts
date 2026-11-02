import { describe, expect, it } from "vitest";
import { Memo } from "../memo.ts";

type Box = { readonly n: number };

describe("Memo", () => {
  it("computes only the items nobody claimed, and shares answers with who asks meanwhile", async () => {
    const memo = new Memo<Box>();
    const computed: string[][] = [];
    const compute = async (claimed: readonly string[]) => {
      computed.push([...claimed]);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return new Map(claimed.map((k) => [k, { n: k.length }]));
    };
    const [a, b] = await Promise.all([
      memo.resolve(["x", "yy"], (k) => k, compute),
      memo.resolve(["yy", "zzz"], (k) => k, compute),
    ]);

    expect(computed).toEqual([["x", "yy"], ["zzz"]]);
    expect(a.get("yy")).toBe(b.get("yy"));
    expect(memo.peek("zzz")).toEqual({ n: 3 });
  });

  it("a failed computation fails every waiter, and a key left unanswered is a failure", async () => {
    const memo = new Memo<Box>();
    const boom = new Error("boom");
    const first = memo.resolve(
      ["k"],
      (k) => k,
      async () => Promise.reject(boom),
    );
    const waiter = memo.resolve(
      ["k"],
      (k) => k,
      async () => new Map(),
    );
    await expect(first).rejects.toBe(boom);
    await expect(waiter).rejects.toBe(boom);

    const other = new Memo<Box>();
    await expect(
      other.resolve(
        ["k"],
        (k) => k,
        async () => new Map(),
      ),
    ).rejects.toThrow(/unanswered/);
  });

  it("settles once: a later settle or fail changes nothing", async () => {
    const memo = new Memo<Box>();
    expect(memo.claim("k")).toBe(true);
    expect(memo.claim("k")).toBe(false);
    memo.settle("k", { n: 1 });
    memo.settle("k", { n: 2 });
    memo.fail(["k"], new Error("late"));
    await expect(memo.wait("k")).resolves.toEqual({ n: 1 });
  });
});
