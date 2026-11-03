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

### A strict run checks a provider's field values against their schemas

Only for a graph whose provider fields declare a `schema` and a run that validates `"strict"`. The
values are now read as the schema parses them, and a ref with a value its schema refuses is
`unknown: failed`. A schema that described the value the application wanted rather than the one the
source gives now takes what the source gives, or the field leaves it out.

```ts
// before: never run, so a count the source gives as text ("12") was read as text
raw: { streams: { meta: { label: "Streams" }, schema: z.number() } },
// after: the schema takes the text and the run reads 12
raw: { streams: { meta: { label: "Streams" }, schema: z.coerce.number() } },
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
