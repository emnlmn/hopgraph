// The global properties the compiler cannot hold (DESIGN.md §4, §7), run by the application's graph
// test: every (base, provider) pair has a route; every route's paths chain and start and end where
// they should; every loader is used; every entity whose carried attributes are needed has a
// hydrator. It also lists the paths no route uses, for a committed file: a new relation that opens
// a way shows in review. Each problem has the code a builder or a run would throw it with, so a
// graph test can tell them apart without reading the words.

import type { DefinitionCode } from "./errors.ts";
import type { GraphDef, Path, RelationDef, RouteDef } from "./graph.ts";

/** One thing `checkGraph` found wrong with a graph. */
export interface GraphProblem {
  /** what is wrong, for a test to tell problems apart: the code a builder or a run would throw */
  readonly code: DefinitionCode;
  /** the same in words, for a person; the words may change between versions */
  readonly message: string;
}

/** What `checkGraph` says of a graph. */
export interface GraphCheck {
  /** everything wrong with the graph; none for a graph every run can use */
  readonly problems: readonly GraphProblem[];
  /** per `base › provider`, the relation paths (ids joined by " · ") no route uses */
  readonly alternatives: Readonly<Record<string, readonly string[]>>;
}

/**
 * Checks what the compiler cannot, for the application's graph test: every pair of a base in
 * `bases` and a provider has a route; every route's paths chain from its base to its provider's
 * entity; every route starts at a base; every loader is used; every entity whose carried
 * attributes a load or a projection needs has a hydrator. It also lists, per pair, the relation
 * paths of up to `maxDepth` relations (4) that no route uses, for a committed file, so that a new
 * relation that opens a way shows in review.
 */
export function checkGraph<Meta>(
  graph: GraphDef<Meta>,
  opts: { readonly bases: readonly string[]; readonly maxDepth?: number },
): GraphCheck {
  return {
    problems: [
      ...baseProblems(graph, opts.bases),
      ...pairProblems(graph, opts.bases),
      ...routeEndProblems(graph, opts.bases),
      ...unusedLoaders(graph),
      ...missingHydrators(graph),
    ],
    alternatives: alternatives(graph, opts.bases, opts.maxDepth ?? 4),
  };
}

function problem(code: DefinitionCode, message: string): GraphProblem {
  return { code, message };
}

/** Bases that are not entities. */
function baseProblems<Meta>(graph: GraphDef<Meta>, bases: readonly string[]): GraphProblem[] {
  return bases
    .filter((base) => !Object.hasOwn(graph.entities, base))
    .map((base) => problem("HG_UNKNOWN_ENTITY", `base "${base}" is not an entity`));
}

/** Every pair of a base and a provider, base by base, with the route the graph gives it. */
function pairs<Meta>(graph: GraphDef<Meta>, bases: readonly string[]) {
  const routeOf = new Map(graph.routes.map((r) => [`${r.base}␟${r.provider}`, r]));
  return bases.flatMap((base) =>
    [...graph.providers.values()].map((provider) => ({
      base,
      provider,
      pair: `${base} › ${provider.id}`,
      route: routeOf.get(`${base}␟${provider.id}`),
    })),
  );
}

/** Pairs with no route, and what is wrong with the routes of the others. Every base must reach
 *  every provider: there is no way to declare a pair unreachable. */
function pairProblems<Meta>(graph: GraphDef<Meta>, bases: readonly string[]): GraphProblem[] {
  return pairs(graph, bases).flatMap(({ base, provider, pair, route }) =>
    route
      ? routeProblems(route, base, provider.entity, graph.relations)
      : [problem("HG_NO_ROUTE", `${pair}: no route`)],
  );
}

/** Routes from an entity that is not a base, or to a provider the graph does not have. */
function routeEndProblems<Meta>(graph: GraphDef<Meta>, bases: readonly string[]): GraphProblem[] {
  const out: GraphProblem[] = [];
  for (const route of graph.routes) {
    if (!bases.includes(route.base))
      out.push(problem("HG_NOT_A_BASE", `route from "${route.base}": not a base`));
    if (!graph.providers.has(route.provider))
      out.push(problem("HG_UNKNOWN_PROVIDER", `route to "${route.provider}": no such provider`));
  }
  return out;
}

/** Loaders no relation, verification, hydrator or provider reads with. */
function unusedLoaders<Meta>(graph: GraphDef<Meta>): GraphProblem[] {
  const used = new Set<string>();
  for (const r of graph.relations.values()) {
    for (const s of r.strategies) used.add(s.loader);
    if (r.verify) used.add(r.verify.loader);
  }
  for (const h of graph.hydrators.values()) used.add(h.loader);
  for (const p of graph.providers.values()) used.add(p.loader);
  return [...graph.loaders.keys()]
    .filter((id) => !used.has(id))
    .map((id) => problem("HG_UNUSED_LOADER", `loader "${id}" is not used`));
}

/** Entities with needed attributes their context does not carry, and no hydrator to read them. */
function missingHydrators<Meta>(graph: GraphDef<Meta>): GraphProblem[] {
  const out: GraphProblem[] = [];
  for (const [entity, all] of neededAttributes(graph)) {
    if (graph.hydrators.has(entity)) continue;
    const context = new Set(graph.entities[entity]?.context ?? []);
    const attrs = [...all].filter((a) => !context.has(a));
    if (attrs.length > 0)
      out.push(
        problem(
          "HG_NO_HYDRATOR",
          `entity "${entity}" has needed attributes (${attrs.join(", ")}) and no hydrator`,
        ),
      );
  }
  return out;
}

/** Per entity, the attributes a load or a projection needs of it. */
function neededAttributes<Meta>(graph: GraphDef<Meta>): Map<string, Set<string>> {
  const needed = new Map<string, Set<string>>();
  const need = (entity: string, attrs: readonly string[]) => {
    for (const a of attrs) needed.set(entity, (needed.get(entity) ?? new Set()).add(a));
  };
  for (const l of graph.loaders.values()) need(l.keyedBy, l.needs);
  for (const r of graph.relations.values()) for (const s of r.strategies) need(r.from, s.needs);
  return needed;
}

/** Per pair with a route, the relation paths that reach the provider's entity and the route does
 *  not use. */
function alternatives<Meta>(
  graph: GraphDef<Meta>,
  bases: readonly string[],
  maxDepth: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { base, provider, pair, route } of pairs(graph, bases)) {
    if (!route) continue;
    const used = new Set(pathsOf(route).map((p) => p.relations.join(" · ")));
    const unused = simplePaths(graph.relations, base, provider.entity, maxDepth)
      .map((p) => p.join(" · "))
      .filter((p) => !used.has(p));
    if (unused.length > 0) out[pair] = unused.sort();
  }
  return out;
}

function pathsOf(route: RouteDef): readonly Path<string, string>[] {
  return route.how.kind === "path" ? [route.how] : route.how.paths;
}

/** What is wrong with a route's paths: a relation not declared, a path that does not chain from
 *  the base, or does not end at the provider's entity. `g.route` and `g.graph` refuse the first;
 *  `checkGraph` lists them all. */
export function routeProblems(
  route: RouteDef,
  base: string,
  entity: string,
  relations: ReadonlyMap<string, RelationDef>,
): GraphProblem[] {
  const at = `${route.base} › ${route.provider}`;
  const out: GraphProblem[] = [];
  for (const p of pathsOf(route)) {
    let at_ = base;
    for (const id of p.relations) {
      const r = relations.get(id);
      if (!r) {
        out.push(problem("HG_UNKNOWN_RELATION", `${at}: relation "${id}" is not declared`));
        break;
      }
      if (r.from !== at_)
        out.push(
          problem("HG_PATH", `${at}: "${id}" starts at "${r.from}", the path is at "${at_}"`),
        );
      at_ = r.to;
    }
    if (at_ !== entity)
      out.push(
        problem("HG_PATH", `${at}: a path ends at "${at_}", the provider is keyed by "${entity}"`),
      );
  }
  return out;
}

/** Every simple path (no entity twice) of declared relations from `from` to `to`, as relation
 *  ids. */
function simplePaths(
  relations: ReadonlyMap<string, RelationDef>,
  from: string,
  to: string,
  maxDepth: number,
): string[][] {
  const out: string[][] = [];
  const walk = (at: string, seen: Set<string>, ids: string[]) => {
    if (ids.length > 0 && at === to) {
      out.push(ids);
      return;
    }
    if (ids.length === maxDepth) return;
    for (const r of relations.values()) {
      if (r.from !== at || seen.has(r.to)) continue;
      walk(r.to, new Set(seen).add(r.to), [...ids, r.id]);
    }
  };
  walk(from, new Set([from]), []);
  return out;
}
