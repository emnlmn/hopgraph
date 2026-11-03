// Found in review. A runner's `read` named each row by the entity's `id` of the key as the caller
// gave it, before the run parsed it. With a key schema that parses (`"5"` to 5) and an `id` that
// needs the parsed key, the run succeeded and `read` then threw a raw TypeError from `id("5")`.
// And `read` and `g.ref` took the key type the schema parses to, so the `"5"` the schema accepts
// did not compile.
//
// Fixed: `read` names each row by the id the run computed of the parsed key (src/run/runner.ts,
// src/run/executor.ts), and `g.ref` by the id of the key its schema parses at once; an `id` that
// throws on a key rejects the run with a ValidationError naming the row by its place, never its
// value. `read` and `g.ref` take what the key's schema accepts (`KeyInputOf`), loads and links
// what it parses to (src/core/graph.ts).

import {
  createRunner,
  entity,
  envelope,
  found,
  hopgraph,
  type Retention,
  type Schema,
  ValidationError,
} from "hopgraph";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

/** A disc by its number, given as text: `"07"` is disc 7, whose id is `"7"`. */
function graph(id: (n: number) => string = (n) => n.toFixed(0)) {
  const g = hopgraph<{ readonly label: string }>().entities({
    disc: entity({ key: z.string().transform((s) => Number(s)), id }),
    tag: entity({ key: text }),
  });
  const seen: unknown[] = [];
  const titles = g.loader({
    id: "titles",
    version: 1,
    keyedBy: "disc",
    connectors: { allOf: ["db"] },
    batch: { by: "partition" },
    keep: (): Retention => "day",
    partial: "keep",
    load: async (refs) => {
      // the loader sees the parsed key
      expectTypeOf(refs[0]?.key).toEqualTypeOf<number | undefined>();
      seen.push(...refs.map((r) => r.key));
      return envelope(refs.map((r) => [r.key, found({ title: `Disc ${r.key}` })] as const));
    },
  });
  const title = g.provider("title", {
    loader: titles,
    temporal: "current",
    rows: "one",
    project: (v) => [{ title: v.title }],
    raw: { title: { meta: { label: "Title" } } },
  });
  return { g, title, seen, graph: g.graph(g.route("disc", title, g.itself("disc"))) };
}

describe("read with a key schema that parses", () => {
  it("names each row by the id of the parsed key, and loads the parsed key", async () => {
    const { graph: built, title, seen } = graph();
    const runner = createRunner(built);
    const result = await runner.read("disc", ["07", "12"], [title]);

    expect([...result.rows.keys()]).toEqual(["7", "12"]);
    expect(result.rows.get("7")?.providers.title.rows[0]?.fields).toEqual({ title: "Disc 7" });
    expect(seen.sort()).toEqual([12, 7]);
  });

  it("with validation off, the key given is the key", async () => {
    const { graph: built, title } = graph(String);
    const runner = createRunner(built);
    const result = await runner.read("disc", ["07"], [title], { validate: "off" });

    expect([...result.rows.keys()]).toEqual(["07"]);
  });

  it("an id that throws on a parsed key rejects the read by the row's place, not its value", async () => {
    const {
      graph: built,
      title,
      seen,
    } = graph((n) => {
      if (n === 13) throw new TypeError(`no disc ${n}`);
      return String(n);
    });
    const runner = createRunner(built);
    const error = await runner.read("disc", ["7", "13"], [title]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).rows).toEqual([
      { row: "keys[1]", entity: "disc", field: "key" },
    ]);
    expect(String((error as Error).message)).not.toContain("13");
    expect(seen).toEqual([]);
  });

  it("read and g.ref take what the schema accepts; a Schema<T>, its type", () => {
    const { g, title, graph: built } = graph();
    const runner = createRunner(built);
    const check = () => {
      void runner.read("disc", ["5"], [title]);
      // @ts-expect-error: the schema accepts text
      void runner.read("disc", [5], [title]);
      g.ref("disc", "5");
      // @ts-expect-error: as here
      g.ref("disc", 5);
      // @ts-expect-error: a Schema<string> says it accepts anything: its key is still a string
      g.ref("tag", 5);
    };
    expect(check).toBeTypeOf("function");
  });

  it("g.ref names its row by the id of the key as parsed, as read does", () => {
    const { g } = graph();
    expect(g.ref("disc", "07")).toEqual({ row: "7", entity: "disc", key: "07" });
    expect(g.ref("disc", "07", {}, "mine").row).toBe("mine");
  });
});
