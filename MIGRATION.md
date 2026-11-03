# Migration

What a consumer changes to move to the next version: each breaking change, the code before and the
code after. Changes that need no edit are in [CHANGELOG.md](CHANGELOG.md) only.

## Unreleased

### Move `Ctx` to the last type argument of `hopgraph()`

Only for a graph written with type arguments: `Meta` and the connectors come first, and `Ctx`
comes last, as `undefined` unless given.

```ts
// before
const g = hopgraph<undefined, Meta, "db">().entities({ track });
const h = hopgraph<Ctx, Meta, "db">().entities({ track });
const k = hopgraph<Ctx, Meta>().entities({ track });
// after
const g = hopgraph<Meta, "db">().entities({ track });
const h = hopgraph<Meta, "db", Ctx>().entities({ track });
const k = hopgraph<Meta, string, Ctx>().entities({ track });
```

## [0.2.1] - 2026-11-02

## [0.2.0] - 2026-11-02

### `read` and `g.ref` take a key as its schema accepts it

Only for an entity whose key schema states an input type other than its output: the key is given
as the schema accepts it, and loads still get the parsed key.

```ts
const disc = entity({ key: z.string().transform(Number), id: (n) => n.toFixed(0) });
// before
await runner.read("disc", [7], [title]);
// after
await runner.read("disc", ["7"], [title]);
```
