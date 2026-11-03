// Values checked against their schemas where they enter a run (DESIGN.md §5.6). The schemas are
// Standard Schema values (core/standard.ts); a run calls them on what comes from outside it: the
// base rows' keys and carried attributes before anything is read, then what a source says through
// a projection: a link's target key, its attributes and the target's carried attributes, and what a
// hydrator projects; under `strict`, also the values a provider projects, against their fields'
// schemas. A value that passes is replaced by what its schema parsed, so a key a schema coerces is
// read as the type the graph declares. An attribute the entity does not declare fails; a field
// without a schema is not checked.
//
// A base row that fails rejects the run, named by row id and field: the caller sent it. A projected
// value that fails is the source's: the key it came through is `unknown: failed`, counted under the
// failure code `HG_INVALID`, and the run goes on. A schema's issue messages may quote the value, so
// none is kept. A validator that throws fails its value; an asynchronous one is awaited.

import {
  type Attrs,
  type EntityDef,
  type InvalidRow,
  type LinkOut,
  type RelationDef,
  type Schema,
  ValidationError,
} from "../core/index.ts";
import { entityOf } from "./refs.ts";
import type { BaseRef } from "./types.ts";

type Out = LinkOut<unknown, Attrs, Attrs>;

/** `off`: no schema runs. `boundaries`: base rows, links and hydrations. `strict`: also every
 *  envelope a load returns (envelope.ts) and the values a provider projects (providers.ts). */
export type Validation = "off" | "boundaries" | "strict";

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const FAILS: Parsed = { ok: false };

async function parse(schema: Schema<unknown>, value: unknown): Promise<Parsed> {
  try {
    const result = await schema["~standard"].validate(value);
    return result.issues === undefined ? { ok: true, value: result.value } : FAILS;
  } catch {
    return FAILS;
  }
}

/** Carried attributes as the entity's schemas parse them, and the names of those that fail. An
 *  absent (undefined) attribute is not checked. */
async function carried(
  entity: EntityDef,
  attrs: Attrs,
): Promise<{ readonly value: Attrs; readonly failed: readonly string[] }> {
  const present = Object.entries(attrs).filter(([, v]) => v !== undefined);
  const parsed = await Promise.all(
    present.map(([name, v]) => {
      const schema = Object.hasOwn(entity.carries, name) ? entity.carries[name] : undefined;
      return schema ? parse(schema, v) : FAILS;
    }),
  );
  const value: Record<string, unknown> = {};
  const failed: string[] = [];
  present.forEach(([name], i) => {
    const p = parsed[i];
    if (p?.ok) value[name] = p.value;
    else failed.push(name);
  });
  return { value, failed };
}

/** The base rows as their schemas parse them; a `ValidationError` naming every row that fails. */
export async function validBase(
  entities: Readonly<Record<string, EntityDef>>,
  rows: readonly BaseRef[],
): Promise<BaseRef[]> {
  const checked = await Promise.all(
    rows.map(async (row) => {
      const entity = entityOf(entities, row.entity);
      const [key, attrs] = await Promise.all([
        parse(entity.key, row.key),
        carried(entity, row.carries ?? {}),
      ]);
      const invalid: InvalidRow[] = [
        ...(key.ok ? [] : [{ row: row.row, entity: row.entity, field: "key" }]),
        ...attrs.failed.map((name) => ({
          row: row.row,
          entity: row.entity,
          field: `carries.${name}`,
        })),
      ];
      const parsed: BaseRef = { ...row, key: key.ok ? key.value : row.key, carries: attrs.value };
      return { row: parsed, invalid };
    }),
  );
  const invalid = checked.flatMap((c) => c.invalid);
  if (invalid.length > 0) throw new ValidationError(invalid);
  return checked.map((c) => c.row);
}

/** What a hydrator projected, parsed; `undefined` when an attribute fails. */
export async function validCarried(entity: EntityDef, attrs: Attrs): Promise<Attrs | undefined> {
  const { value, failed } = await carried(entity, attrs);
  return failed.length > 0 ? undefined : value;
}

/** A provider row's values as their fields' schemas parse them; `undefined` when one fails. A
 *  field without a schema, or that the row does not hold or holds as undefined, is not checked:
 *  a field may be optional, and the schema says what a value is, not whether there is one. */
export async function validFields(
  fields: Readonly<Record<string, { readonly schema?: Schema<unknown> | undefined }>>,
  row: Attrs,
): Promise<Attrs | undefined> {
  const checked = Object.entries(fields).flatMap(([name, { schema }]) =>
    schema && Object.hasOwn(row, name) && row[name] !== undefined ? [{ name, schema }] : [],
  );
  const parsed = await Promise.all(checked.map(({ name, schema }) => parse(schema, row[name])));
  const value: Record<string, unknown> = { ...row };
  for (const [i, { name }] of checked.entries()) {
    const p = parsed[i];
    if (!p?.ok) return undefined;
    value[name] = p.value;
  }
  return value;
}

/** A projection's links, parsed: target key, link attributes (when the relation declares their
 *  schema) and the target's carried attributes; `undefined` when one of them fails. */
export async function validLinks(
  relation: RelationDef,
  target: EntityDef,
  outs: readonly Out[],
): Promise<Out[] | undefined> {
  const checked = await Promise.all(
    outs.map(async (out): Promise<Out | undefined> => {
      const [to, attrs, carries] = await Promise.all([
        parse(target.key, out.to),
        // a link without attributes has none: `{}` is what the lineage shows for it
        relation.link
          ? parse(relation.link, out.attrs ?? {})
          : ({ ok: true, value: out.attrs } as const),
        out.carries === undefined ? undefined : validCarried(target, out.carries),
      ]);
      if (!to.ok || !attrs.ok || (out.carries !== undefined && carries === undefined))
        return undefined;
      // as the projection gave it, parsed: a link it gave without attributes still has none
      return {
        to: to.value,
        ...(attrs.value === undefined ? {} : { attrs: attrs.value }),
        ...(carries === undefined ? {} : { carries }),
      } as Out;
    }),
  );
  return checked.every((out) => out !== undefined) ? checked : undefined;
}
