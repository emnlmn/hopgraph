// Found by review of the run code. A tracer's methods are typed to return nothing, so an async one
// type-checks, and a run kept a tracer's failures out of its answer by catching what they threw.
// An async method does not throw: it returns a rejected promise, which the run dropped, and on Node
// an unhandled rejection ends the process after the run has answered. Also, a span that failed to
// start was replaced by one shared quiet span, so its children started with no parent at all.
//
// Fixed: a method's promise, when it returns one, has its rejection caught; a span that failed to
// start hands its children to the nearest span that did (src/run/executor.ts `guarded`).

import {
  entity,
  envelope,
  found,
  hopgraph,
  run,
  type Schema,
  type Span,
  type Tracer,
} from "hopgraph";
import { afterEach, expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

function build() {
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
  });
  const tracks = g.loader({
    id: "tracks",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch: { by: "partition" },
    load: async (refs) => envelope(refs.map((r) => [r.key, found({ plays: 1 })])),
  });
  return (tracer: Tracer) =>
    run(
      g.graph(
        g.route(
          "track",
          g.provider("plays", {
            loader: tracks,
            temporal: "historical",
            rows: "one",
            project: (v) => [v],
            raw: { plays: { meta: { label: "Plays" } } },
          }),
          g.itself("track"),
        ),
      ),
      {
        refs: [{ row: "r1", entity: "track", key: "t1" }],
        providers: ["plays"],
        ctx: {},
        readable: () => true,
        cache: { getMany: async () => new Map(), setMany: async () => undefined },
        limits: {},
        tracer,
      },
    );
}

const unhandled: unknown[] = [];
const listen = (reason: unknown) => unhandled.push(reason);
afterEach(() => {
  process.off("unhandledRejection", listen);
  unhandled.length = 0;
});

it("a tracer whose methods reject leaves no unhandled rejection behind the run", async () => {
  process.on("unhandledRejection", listen);
  const rejecting: Span = {
    setAttribute: async () => {
      throw new Error("exporter down");
    },
    addEvent: async () => {
      throw new Error("exporter down");
    },
    recordError: async () => {
      throw new Error("exporter down");
    },
    end: async () => {
      throw new Error("exporter down");
    },
  };
  const result = await build()({ startSpan: () => rejecting });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(result.status).toBe("complete");
  expect(unhandled).toEqual([]);
});

it("the children of a span that failed to start hang on the nearest span that did", async () => {
  const parents: { readonly name: string; readonly parent: string | undefined }[] = [];
  const names = new WeakMap<Span, string>();
  const tracer: Tracer = {
    startSpan(name, _attributes, parent) {
      if (name === "hopgraph.batch") throw new Error("no batch spans today");
      parents.push({ name, parent: parent && names.get(parent) });
      const span: Span = {
        setAttribute: () => undefined,
        addEvent: () => undefined,
        recordError: () => undefined,
        end: () => undefined,
      };
      names.set(span, name);
      return span;
    },
  };
  await build()(tracer);

  expect(parents.length).toBeGreaterThan(1);
  for (const { name, parent } of parents)
    expect(parent, name).toBe(name === "hopgraph.run" ? undefined : "hopgraph.run");
});
