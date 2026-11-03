// Hopgraph run: the executor over a declared graph (DESIGN.md §5, §6). Imports core only.

export { type MemoryCacheOptions, memoryCache } from "./cache.ts";
export { run } from "./executor.ts";
export { createInflight, type Inflight } from "./flights.ts";
export {
  type CircuitState,
  type ConnectorHealth,
  createHealth,
  type Health,
} from "./health.ts";
export { createRunner } from "./runner.ts";
export type {
  BaseRef,
  CachedAnswer,
  CachePort,
  Caps,
  FieldsOf,
  Gate,
  LinkStep,
  ProviderRef,
  ProviderResult,
  ProviderResults,
  ProviderRow,
  ReadCall,
  ReadKey,
  ReadKeys,
  RoutedProviders,
  RowResult,
  RowStep,
  RunCall,
  RunEnv,
  Runner,
  RunOptions,
  RunResult,
  Span,
  SpanAttributes,
  SpanValue,
  Tracer,
  TraceStep,
} from "./types.ts";
export type { Validation } from "./validate.ts";
