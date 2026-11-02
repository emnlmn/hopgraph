// Refs (DESIGN.md §3, §3.2). A ref is a key and the carried values that came with it, from the base
// row or from the link that reached it. Two links that bring different values for one key reach two
// refs (a window around each referring track's date); links that bring the same values, or none,
// reach the same ref. The hydrator reads by key alone, so what it says holds for every ref of the
// key, and the values that came with a ref win over it.

import { type Attrs, DefinitionError, type EntityDef, type Ref } from "../core/index.ts";
import { stableJson } from "./ids.ts";

/** A key of an entity: what a row step, a row and a link show. */
export interface RefId {
  readonly entity: string;
  readonly keyId: string;
}

export interface RefNode extends RefId {
  readonly key: unknown;
  /** what the base row or the reaching link said about it */
  readonly given: Attrs;
  /** entity, key id and given values */
  readonly id: string;
}

/** The declared entity of a name; a name that is not one is refused (`HG_UNKNOWN_ENTITY`). */
export function entityOf(entities: Readonly<Record<string, EntityDef>>, name: string): EntityDef {
  const entity = Object.hasOwn(entities, name) ? entities[name] : undefined;
  if (!entity) throw new DefinitionError("HG_UNKNOWN_ENTITY", `no entity "${name}"`);
  return entity;
}

/** How a key appears in a result: its id, or its digest when the entity's key is personal. */
export type Show = (ref: RefId) => string;

export class RefStore {
  private readonly refs = new Map<string, RefNode>();
  /** per key: what its hydrator said */
  private readonly hydrated = new Map<string, Record<string, unknown>>();

  constructor(private readonly entities: Readonly<Record<string, EntityDef>>) {}

  intern(entity: string, key: unknown, given?: Attrs): RefNode {
    const keyId = entityOf(this.entities, entity).id(key);
    const values = Object.fromEntries(
      Object.entries(given ?? {}).filter(([, value]) => value !== undefined),
    );
    const id = `${entity}␟${keyId}␟${stableJson(values)}`;
    let ref = this.refs.get(id);
    if (!ref) {
      ref = { entity, keyId, key, given: values, id };
      this.refs.set(id, ref);
    }
    return ref;
  }

  /** Keeps what the hydrator said about a key; a value it already said stays. */
  learn(ref: RefId, attrs: Attrs | undefined): void {
    const known = this.hydrated.get(keyText(ref)) ?? {};
    for (const [name, value] of Object.entries(attrs ?? {}))
      if (value !== undefined && known[name] === undefined) known[name] = value;
    this.hydrated.set(keyText(ref), known);
  }

  /**
   * Whether a step reading `needs` must hydrate the ref first: its given values lack a need its
   * hydrator can give. A context attribute (only a base row or a link brings it) never asks.
   */
  lacks(ref: RefNode, needs: readonly string[]): boolean {
    const { context } = entityOf(this.entities, ref.entity);
    return needs.some((need) => ref.given[need] === undefined && !context.includes(need));
  }

  /** The needs a step reading `needs` cannot have: in neither the given values nor the
   *  hydration. */
  missing(ref: RefNode, needs: readonly string[]): string[] {
    const carried = this.carried(ref, needs);
    return needs.filter((need) => carried[need] === undefined);
  }

  /**
   * The ref as a load or a projection sees it: its key, the declared needs, the hints present.
   * `stepNeeds` are the needs of the whole step (a strategy's and its loader's together).
   */
  view(
    ref: RefNode,
    needs: readonly string[],
    hints: readonly string[],
    stepNeeds: readonly string[] = needs,
  ): Ref<unknown, Attrs> {
    return { ...this.values(ref, needs, hints, stepNeeds), key: ref.key };
  }

  /** What a load or a projection reads of the ref besides its key: needs, and hints when
   *  present. */
  values(
    ref: RefNode,
    needs: readonly string[],
    hints: readonly string[],
    stepNeeds: readonly string[] = needs,
  ): Attrs {
    const carried = this.carried(ref, stepNeeds);
    const values: Record<string, unknown> = {};
    for (const name of [...hints, ...needs])
      if (carried[name] !== undefined) values[name] = carried[name];
    return values;
  }

  /**
   * What a step reading `stepNeeds` sees carried: the given values when they hold every need it
   * can hydrate; else the key's hydration under them, which then serves its hints too. A step that
   * needed no hydration sees none, so what it reads never depends on whether another step
   * hydrated the key first.
   */
  private carried(ref: RefNode, stepNeeds: readonly string[]): Attrs {
    if (!this.lacks(ref, stepNeeds)) return ref.given;
    return { ...this.hydrated.get(keyText(ref)), ...ref.given };
  }
}

/** One text per key, across entities. */
export const keyText = (ref: RefId): string => `${ref.entity}␟${ref.keyId}`;

/** A ref's identity for a step that reads `attrs` of what came with it: refs of one key that
 *  agree on those values are one for that step. */
export function identity(ref: RefNode, attrs: readonly string[]): string {
  if (attrs.length === 0) return ref.keyId;
  const read = Object.fromEntries(attrs.map((name) => [name, ref.given[name]]));
  return `${ref.keyId}␟${stableJson(read)}`;
}

/** The refs, each once, in their first order. */
export function distinctRefs(refs: Iterable<RefNode>): RefNode[] {
  return [...new Map([...refs].map((ref) => [ref.id, ref])).values()];
}

/** Shows a personal key by its digest (computed once per key), any other by its id. */
export function showKeys(
  entities: Readonly<Record<string, EntityDef>>,
  digest: (entity: string, keyId: string) => string,
): Show {
  const digests = new Map<string, string>();
  return (ref) => {
    if (!entities[ref.entity]?.personal) return ref.keyId;
    let shown = digests.get(keyText(ref));
    if (shown === undefined) {
      shown = digest(ref.entity, ref.keyId);
      digests.set(keyText(ref), shown);
    }
    return shown;
  };
}
