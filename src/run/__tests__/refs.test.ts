import { describe, expect, it } from "vitest";
import { z } from "zod";
import { entity, hopgraph } from "../../core/index.ts";
import { distinctRefs, identity, RefStore, showKeys } from "../refs.ts";

const entities = hopgraph<object, unknown>()
  .entities({
    track: entity({
      key: z.string(),
      carries: { releasedAt: z.string(), catalog: z.string(), window: z.string() },
      context: ["window"],
    }),
    email: entity({ key: z.string(), personal: true }),
  })
  .graph().entities;

describe("RefStore", () => {
  it("a ref is a key and the values that came with it: other values, another ref", () => {
    const refs = new RefStore(entities);
    const a = refs.intern("track", "t1", { releasedAt: "2026-09-01" });
    expect(refs.intern("track", "t1", { releasedAt: "2026-09-01", catalog: undefined })).toBe(a);
    expect(refs.intern("track", "t1", { releasedAt: "2026-03-03" })).not.toBe(a);
    expect(distinctRefs([a, a, refs.intern("track", "t1")])).toHaveLength(2);
    expect(() => refs.intern("statement", "s1")).toThrow(/no entity/);
  });

  it("given values win over the hydrator, which fills the needs they lack", () => {
    const refs = new RefStore(entities);
    const ref = refs.intern("track", "t1", { releasedAt: "2026-10-01" });
    refs.learn(ref, { releasedAt: "2026-10-15", catalog: "it" });
    refs.learn(ref, { catalog: "fr" });
    expect(refs.view(ref, ["releasedAt", "catalog"], [])).toEqual({
      key: "t1",
      releasedAt: "2026-10-01",
      catalog: "it",
    });
  });

  it("a step whose needs the given values hold sees no hydration, hints included", () => {
    const refs = new RefStore(entities);
    const given = refs.intern("track", "t2", { releasedAt: "2026-06-30" });
    refs.learn(given, { releasedAt: "2026-07-01", catalog: "fr" });
    expect(refs.view(given, ["releasedAt"], ["catalog"])).toEqual({
      key: "t2",
      releasedAt: "2026-06-30",
    });
    const bare = refs.intern("track", "t2");
    expect(refs.view(bare, ["releasedAt"], ["catalog"])).toEqual({
      key: "t2",
      releasedAt: "2026-07-01",
      catalog: "fr",
    });
    expect(refs.missing(refs.intern("track", "t9"), ["releasedAt"])).toEqual(["releasedAt"]);
    expect(refs.lacks(bare, ["releasedAt"])).toBe(true);
  });

  it("a hint sees the hydration another need of the same step ran, and only then", () => {
    const refs = new RefStore(entities);
    const ref = refs.intern("track", "t3", { releasedAt: "2026-05-05" });
    refs.learn(ref, { catalog: "it" });
    // the loader's own need is given; the strategy's need of the same step hydrated the key
    expect(refs.view(ref, ["releasedAt"], ["catalog"])).toEqual({
      key: "t3",
      releasedAt: "2026-05-05",
    });
    expect(refs.view(ref, ["releasedAt"], ["catalog"], ["releasedAt", "catalog"])).toEqual({
      key: "t3",
      releasedAt: "2026-05-05",
      catalog: "it",
    });
  });

  it("a context attribute never asks for hydration: only a base row or a link brings it", () => {
    const refs = new RefStore(entities);
    const ref = refs.intern("track", "t4", { releasedAt: "2026-04-04" });
    expect(refs.lacks(ref, ["window"])).toBe(false);
    expect(refs.missing(ref, ["window"])).toEqual(["window"]);
    expect(refs.lacks(ref, ["window", "catalog"])).toBe(true);
  });

  it("refs of one key that agree on what a step reads are one for that step", () => {
    const refs = new RefStore(entities);
    const a = refs.intern("track", "t1", { releasedAt: "2026-09-01", catalog: "it" });
    const b = refs.intern("track", "t1", { releasedAt: "2026-09-01", catalog: "fr" });
    expect(identity(a, ["releasedAt"])).toBe(identity(b, ["releasedAt"]));
    expect(identity(a, ["catalog"])).not.toBe(identity(b, ["catalog"]));
    expect(identity(a, [])).toBe("t1");
  });
});

describe("showKeys", () => {
  it("shows a personal key by its digest, computed once per key; any other by its id", () => {
    const asked: string[] = [];
    const show = showKeys(entities, (e, k) => {
      asked.push(k);
      return `${e}#${k.length}`;
    });
    expect(show({ entity: "email", keyId: "anna@example.com" })).toBe("email#16");
    expect(show({ entity: "email", keyId: "anna@example.com" })).toBe("email#16");
    expect(show({ entity: "track", keyId: "t1" })).toBe("t1");
    expect(asked).toEqual(["anna@example.com"]);
  });
});
