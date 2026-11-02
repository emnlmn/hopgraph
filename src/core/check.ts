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
  const maxDepth = opts.maxDepth ?? 4;
  const problems: GraphProblem[] = [];
  const problem = (code: DefinitionCode, message: string) => problems.push({ code, message });
  const alternatives: Record<string, string[]> = {};
  const routeOf = new Map(graph.routes.map((r) => [`${r.base}␟${r.provider}`, r]));

  for (const base of opts.bases)
    if (!Object.hasOwn(graph.entities, base))
      problem("HG_UNKNOWN_ENTITY", `base "${base}" is not an entity`);

  for (const base of opts.bases) {
    for (const provider of graph.providers.values()) {
      const pair = `${base} › ${provider.id}`;
      const route = routeOf.get(`${base}␟${provider.id}`);
      const reachable =
        base === provider.entity
          ? [[]]
          : simplePaths(graph.relations, base, provider.entity, maxDepth);
      if (!route) {
        // every base must reach every provider: there is no way to declare a pair unreachable
        problem("HG_NO_ROUTE", `${pair}: no route`);
        continue;
      }
      problems.push(...routeProblems(route, base, provider.entity, graph.relations));
      const used = new Set(
        (route.how.kind === "path" ? [route.how] : route.how.paths).map((p) =>
          p.relations.join(" · "),
        ),
      );
      const unused = reachable.map((p) => p.join(" · ")).filter((p) => p !== "" && !used.has(p));
      if (unused.length > 0) alternatives[pair] = unused.sort();
    }
  }

  for (const route of graph.routes) {
    if (!opts.bases.includes(route.base))
      problem("HG_NOT_A_BASE", `route from "${route.base}": not a base`);
    if (!graph.providers.has(route.provider))
      problem("HG_UNKNOWN_PROVIDER", `route to "${route.provider}": no such provider`);
  }

  const used = new Set<string>();
  for (const r of graph.relations.values()) {
    for (const s of r.strategies) used.add(s.loader);
    if (r.verify) used.add(r.verify.loader);
  }
  for (const h of graph.hydrators.values()) used.add(h.loader);
  for (const p of graph.providers.values()) used.add(p.loader);
  for (const id of graph.loaders.keys())
    if (!used.has(id)) problem("HG_UNUSED_LOADER", `loader "${id}" is not used`);

  const needed = new Map<string, Set<string>>();
  const need = (entity: string, attrs: readonly string[]) => {
    for (const a of attrs) needed.set(entity, (needed.get(entity) ?? new Set()).add(a));
  };
  for (const l of graph.loaders.values()) need(l.keyedBy, l.needs);
  for (const r of graph.relations.values()) for (const s of r.strategies) need(r.from, s.needs);
  for (const [entity, all] of needed) {
    const context = new Set(graph.entities[entity]?.context ?? []);
    const attrs = [...all].filter((a) => !context.has(a));
    if (attrs.length > 0 && !graph.hydrators.has(entity))
      problem(
        "HG_NO_HYDRATOR",
        `entity "${entity}" has needed attributes (${attrs.join(", ")}) and no hydrator`,
      );
  }

  return { problems, alternatives };
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
  const paths: readonly Path<string, string>[] =
    route.how.kind === "path" ? [route.how] : route.how.paths;
  const out: GraphProblem[] = [];
  const problem = (code: DefinitionCode, message: string) => out.push({ code, message });
  for (const p of paths) {
    let at_ = base;
    for (const id of p.relations) {
      const r = relations.get(id);
      if (!r) {
        problem("HG_UNKNOWN_RELATION", `${at}: relation "${id}" is not declared`);
        break;
      }
      if (r.from !== at_)
        problem("HG_PATH", `${at}: "${id}" starts at "${r.from}", the path is at "${at_}"`);
      at_ = r.to;
    }
    if (at_ !== entity)
      problem("HG_PATH", `${at}: a path ends at "${at_}", the provider is keyed by "${entity}"`);
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
