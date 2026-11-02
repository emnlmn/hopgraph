// The ids a run hands out (run/ids.ts): SHA-256 checked against the standard's vectors, and every
// format pinned to the text an independent implementation computes for it, so a change that would
// orphan every cache entry or invalidate every approval fails here first.

import { describe, expect, it } from "vitest";
import { answerKey, gateId, keyDigest, keyToken, scopeKey, stableJson } from "../ids.ts";
import { sha256 } from "../sha256.ts";

describe("sha256", () => {
  it("matches the FIPS 180-4 vectors, across block edges and over UTF-8", () => {
    const vectors: [string, string][] = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      ],
      ["x".repeat(55), "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072"],
      ["x".repeat(56), "04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e"],
      ["x".repeat(64), "7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c"],
      ["a".repeat(1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"],
      ["é☃𝄞 ids are UTF-8", "05095b42fab48c244c706244aaba521e085efe0fb57a143e5ad56973dd8e6633"],
    ];
    for (const [text, digest] of vectors) expect(sha256(text), text.slice(0, 12)).toBe(digest);
  });
});

describe("ids, format 1", () => {
  const scans = { id: "scans", version: 2 };
  const t1 = keyToken(scans, "r", "p1", "p1", "{}");
  const t2 = keyToken(scans, "r", "p2", "p2", "{}");

  it("pins every format to its text", () => {
    expect(
      answerKey(
        scans,
        "p1",
        stableJson({ window: "w1" }),
        stableJson({ today: "2026-11-01" }),
        "x",
      ),
    ).toBe(
      "hopgraph:1:answer:scans:2:af2b8962e1f7b9112ac23967c22c809bb8726f3c1c1fc7999ae614242e09d839",
    );
    expect([t1, t2]).toEqual([
      "ccdddac972c4327ace84b9a7d6940047",
      "ea2fd23d0e5b40dbe4bed13f5a3f7074",
    ]);
    const gate = "scans:4d7a1ffe4b4086af1f613654bd79782f113d312f6cf90840d4eb8f31dcd8b9ea";
    expect(gateId(scans, "r", [t1, t2])).toBe(gate);
    expect(scopeKey(gate)).toBe(`hopgraph:1:gate:scans%3A${gate.slice(6)}`);
    expect(keyDigest("email", "ada@example.com")).toBe(
      "78bcc4e5888ed61c37e64027eccd3a1891a92d8b46e27451dc35041443923b08",
    );
  });

  it("an answer entry keeps the loader readable, and no key id", () => {
    const entry = answerKey({ id: "a:b/c", version: 7 }, "TRK-0042", "{}", "{}", "forbidden:x");
    expect(entry).toMatch(/^hopgraph:1:answer:a%3Ab%2Fc:7:[0-9a-f]{64}$/);
    expect(entry).not.toContain("TRK-0042");
  });

  it("an answer entry changes with each of its parts, however they are spelled", () => {
    const at = (loader = scans, key = "p1", read = "{}", data = "{}", restriction = "r") =>
      answerKey(loader, key, read, data, restriction);
    const variants = [
      at(),
      at({ id: "other", version: 2 }),
      at({ id: "scans", version: 3 }),
      at(scans, "p2"),
      at(scans, "p1", '{"w":1}'),
      at(scans, "p1", "{}", '{"today":"2026-11-02"}'),
      at(scans, "p1", "{}", "{}", "s"),
      // the parts are kept apart: moving text from one to the next is another entry
      at(scans, "p1:", "{}", "{}", "r"),
      at(scans, "p", "1{}", "{}", "r"),
    ];
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("a gate id is the same for the same keys in any order, and names no step", () => {
    expect(gateId(scans, "r", [t2, t1])).toBe(gateId(scans, "r", [t1, t2]));
    const base = gateId(scans, "r", [t1]);
    expect(gateId({ id: "other", version: 2 }, "r", [t1])).not.toBe(base);
    expect(gateId({ id: "scans", version: 3 }, "r", [t1])).not.toBe(base);
    expect(gateId(scans, "s", [t1])).not.toBe(base);
    expect(gateId(scans, "r", [t1, t2])).not.toBe(base);
  });

  it("a key token changes with the loader, the restriction, the key, how it is shown and its needs", () => {
    const tokens = [
      keyToken(scans, "r", "p1", "p1", "{}"),
      keyToken({ id: "scans", version: 3 }, "r", "p1", "p1", "{}"),
      keyToken(scans, "s", "p1", "p1", "{}"),
      keyToken(scans, "r", "p2", "p1", "{}"),
      keyToken(scans, "r", "p1", "digest-of-p1", "{}"),
      keyToken(scans, "r", "p1", "p1", '{"w":1}'),
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{32}$/);
  });
});
