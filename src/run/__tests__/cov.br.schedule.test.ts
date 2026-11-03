// The scheduler while a run fails: work of the failed wave does not hold the failure back. Once no
// job of that wave or before is left, the run fails, though a lane of the same wave is still
// checking its links.

import { expect, it } from "vitest";
import { type Envelope, entity, hopgraph, type Schema } from "../../core/index.ts";
import { run } from "../index.ts";
import { type Conn, type Ctx, fake, free, type Meta, options, refs } from "./support.ts";

type Row = { readonly to: readonly string[] };

class Spent extends Error {}

it("a fatal error fails the run without waiting for a lane of its own wave still checking links", async () => {
  const checking = { started: false, ended: false };
  let release: () => void = () => undefined;
  const slowKey: Schema<string> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (v) => {
        checking.started = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        checking.ended = true;
        return { value: String(v) };
      },
    },
  };
  const plain: Schema<string> = {
    "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: String(v) }) },
  };
  const g = hopgraph<Meta, Conn, Ctx>().entities({
    item: entity({ key: plain }),
    slow: entity({ key: slowKey }),
  });
  const on = { ...free, connectors: { allOf: ["db"] } } as const;
  const toSlow = g.loader({
    ...on,
    id: "toSlow",
    keyedBy: "item",
    load: fake<Row>({ found: { i1: { to: ["s1"] } }, delayMs: 1 }).load,
  });
  // it throws once the links of toSlow are being checked
  const bad = g.loader({
    ...on,
    id: "bad",
    keyedBy: "item",
    load: async (): Promise<Envelope<string, Row>> => {
      while (!checking.started) await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Spent("spent");
    },
  });
  const good = g.loader({
    ...on,
    id: "good",
    keyedBy: "slow",
    load: fake<Row>({ found: { s1: { to: [] } } }).load,
  });
  const viaSlow = g.relation("item", "slow", "viaSlow", {
    cardinality: "1:N",
    strategies: (s) => [s(toSlow, { project: (_ref, v) => v.to.map((to) => ({ to })) })],
  });
  const spec = {
    temporal: "historical",
    rows: "many",
    project: (v: Row) => v.to.map((to) => ({ to })),
    raw: { to: { meta: { label: "To" } } },
  } as const;
  const graph = g.graph(
    g.route("item", g.provider("pSlow", { ...spec, loader: good }), g.path(viaSlow)),
    g.route("item", g.provider("pBad", { ...spec, loader: bad }), g.itself("item")),
  );

  const error = await run(graph, {
    ...options({ refs: refs("item", "i1"), providers: ["pSlow", "pBad"] }),
    fatal: (e: unknown) => e instanceof Spent,
  }).catch((e: unknown) => e);
  const endedBeforeFailure = checking.ended;
  release();

  expect(error).toBeInstanceOf(Spent);
  expect(endedBeforeFailure).toBe(false);
});
