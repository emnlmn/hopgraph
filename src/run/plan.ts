// What a run reads, as a graph of steps (DESIGN.md §4, §5.1). Every requested provider is reached
// from every base entity among the rows along its declared route, and each path of a route is a
// chain of steps from the base rows to the provider. A relation or a provider is one step for the
// whole run, shared by every chain through it: it runs once, over every ref that reaches it, when
// the steps feeding it are done. A shared prefix, or a step shared by several bases, is one job.
// Requested routes that order two relations both ways cannot share their steps: the plan refuses
// them, naming the cycle, before anything is read.

import {
  DefinitionError,
  type GraphDef,
  type Path,
  type ProviderDef,
  type RelationDef,
} from "../core/index.ts";

export interface PlannedRoute {
  readonly base: string;
  readonly provider: ProviderDef<unknown>;
  /** every path runs on every base ref. `itself` is the path with no relation; a single path is a
   *  union of one */
  readonly paths: ReadonlyArray<readonly RelationDef[]>;
}

export type Work =
  | { readonly kind: "base"; readonly entity: string }
  | { readonly kind: "relation"; readonly relation: RelationDef }
  | { readonly kind: "provider"; readonly provider: ProviderDef<unknown> };

export interface PlanNode {
  readonly id: string;
  readonly work: Work;
  /** the nodes whose output refs are this node's input */
  readonly feeds: readonly string[];
}

export interface Plan {
  readonly routes: readonly PlannedRoute[];
  readonly nodes: readonly PlanNode[];
}

/** Plans the routes from each base entity to each provider; throws on a route it cannot run. */
export function plan(
  graph: GraphDef<unknown>,
  bases: readonly string[],
  providers: readonly string[],
): Plan {
  const routes = [...new Set(bases)].flatMap((base) =>
    [...new Set(providers)].map((provider) => routeOf(graph, base, provider)),
  );
  const nodes = new NodeBuilder();
  for (const route of routes) nodes.route(route);
  nodes.refuseCycles();
  return { routes, nodes: nodes.list() };
}

function routeOf(graph: GraphDef<unknown>, base: string, providerId: string): PlannedRoute {
  const at = `route "${base}" › "${providerId}"`;
  if (!Object.hasOwn(graph.entities, base))
    throw new DefinitionError("HG_UNKNOWN_ENTITY", `"${base}" is not an entity`);
  const provider = graph.providers.get(providerId);
  if (!provider) throw new DefinitionError("HG_UNKNOWN_PROVIDER", `no provider "${providerId}"`);
  const route = graph.routes.find((r) => r.base === base && r.provider === providerId);
  if (!route) throw new DefinitionError("HG_NO_ROUTE", `no ${at}`);
  const how = route.how;
  const paths = (how.kind === "path" ? [how] : how.paths).map((path) =>
    relationsOf(graph, path, base, provider.entity, at),
  );
  return { base, provider, paths };
}

/** A path's relations, checked to chain from the base to the provider's entity. */
function relationsOf(
  graph: GraphDef<unknown>,
  path: Path<string, string>,
  base: string,
  entity: string,
  at: string,
): RelationDef[] {
  const relations: RelationDef[] = [];
  let here = base;
  for (const id of path.relations) {
    const relation = graph.relations.get(id);
    if (!relation) throw new DefinitionError("HG_UNKNOWN_RELATION", `${at}: no relation "${id}"`);
    if (relation.from !== here)
      throw new DefinitionError(
        "HG_PATH",
        `${at}: "${id}" starts at "${relation.from}", the path is at "${here}"`,
      );
    relations.push(relation);
    here = relation.to;
  }
  if (here !== entity)
    throw new DefinitionError(
      "HG_PATH",
      `${at}: a path ends at "${here}", the provider is keyed by "${entity}"`,
    );
  return relations;
}

interface MutableNode {
  readonly id: string;
  readonly work: Work;
  readonly feeds: MutableNode[];
}

class NodeBuilder {
  private readonly nodes = new Map<string, MutableNode>();

  route(route: PlannedRoute): void {
    const source = this.shared({ kind: "base", entity: route.base }, []);
    for (const path of route.paths) this.chain(source, path, route.provider);
  }

  list(): PlanNode[] {
    return [...this.nodes.values()].map(({ id, work, feeds }) => ({
      id,
      work,
      feeds: feeds.map((feed) => feed.id),
    }));
  }

  /** Throws when shared steps wait on each other in a loop, naming the relations on it. */
  refuseCycles(): void {
    const state = new Map<MutableNode, "open" | "done">();
    const visit = (node: MutableNode, trail: readonly MutableNode[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "open") {
        // the trail runs from a step back to its inputs: read the loop the other way round. Only
        // relations are on it (a base is fed by nothing, a provider feeds nothing), and a
        // relation's step is its id
        const loop = [...trail.slice(trail.indexOf(node)), node].reverse();
        const names = loop.map(({ id }) => `"${id}"`);
        throw new DefinitionError(
          "HG_CYCLE",
          `the requested routes use relations in a cycle (${names.join(", then ")}): ` +
            "ask for them in separate runs",
        );
      }
      state.set(node, "open");
      for (const input of node.feeds) visit(input, [...trail, node]);
      state.set(node, "done");
    };
    for (const node of this.nodes.values()) visit(node, []);
  }

  /** The chain of a path from `from`: a step per relation, then the provider's. Returns its
   *  leaf. */
  private chain(
    from: MutableNode,
    path: readonly RelationDef[],
    provider: ProviderDef<unknown>,
  ): MutableNode {
    let at = from;
    for (const relation of path) at = this.shared({ kind: "relation", relation }, [at]);
    return this.shared({ kind: "provider", provider }, [at]);
  }

  /** The run's one node for this step, now also fed by `feeds`. */
  private shared(work: Work, feeds: readonly MutableNode[]): MutableNode {
    const id = stepOf(work);
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, work, feeds: [] };
      this.nodes.set(id, node);
    }
    for (const feed of feeds) if (!node.feeds.includes(feed)) node.feeds.push(feed);
    return node;
  }
}

function stepOf(work: Work): string {
  switch (work.kind) {
    case "base":
      return `base:${work.entity}`;
    case "relation":
      return work.relation.id;
    case "provider":
      return `provider:${work.provider.id}`;
  }
}
