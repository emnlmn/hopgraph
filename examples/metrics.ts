// Per-loader metrics from a run's spans, with no metrics library. `metrics()` is a `Tracer` that
// keeps, for each loader, what its jobs did (README, "Tracing and metrics"): jobs, keys, cache hits
// and the hit ratio, calls and their attempts and retries, bytes billed, the circuit each call met,
// and the time the jobs took. Hand the numbers to whatever the application measures with; give the
// same object to every run to add them up.
//
// examples/metrics.test.ts runs it on the playlist example, with a cold cache and then a warm one.

import type { CircuitState, Span, SpanAttributes, SpanValue, Tracer } from "hopgraph";

export interface LoaderMetrics {
  jobs: number;
  keys: number;
  /** keys the cache, or another run's load, answered */
  hits: number;
  calls: number;
  attempts: number;
  retries: number;
  billedBytes: number;
  /** calls by the state of the circuit they met: an open one refused them */
  circuits: Record<CircuitState, number>;
  /** the time the jobs took, by this tracer's clock */
  ms: number;
}

export function metrics(now: () => number = () => performance.now()) {
  const loaders = new Map<string, LoaderMetrics>();
  const of = (attributes: SpanAttributes): LoaderMetrics => {
    const loader = String(attributes["hopgraph.loader"]);
    let m = loaders.get(loader);
    if (!m) {
      const circuits = { closed: 0, "half-open": 0, open: 0 };
      m = {
        jobs: 0,
        keys: 0,
        hits: 0,
        calls: 0,
        attempts: 0,
        retries: 0,
        billedBytes: 0,
        circuits,
        ms: 0,
      };
      loaders.set(loader, m);
    }
    return m;
  };
  const n = (value: SpanValue | undefined) => (typeof value === "number" ? value : 0);
  /** a span whose attributes are read when it ends */
  const kept = (attributes: SpanAttributes, ended: (a: SpanAttributes) => void): Span => {
    const all: Record<string, SpanValue> = { ...attributes };
    return {
      setAttribute: (key, value) => {
        all[key] = value;
      },
      addEvent: () => undefined,
      recordError: () => undefined,
      end: () => ended(all),
    };
  };
  const tracer: Tracer = {
    startSpan(name, attributes) {
      const started = now();
      if (name === "hopgraph.load")
        return kept(attributes, (a) => {
          const circuit = a["hopgraph.circuit"];
          if (circuit === "closed" || circuit === "half-open" || circuit === "open")
            of(a).circuits[circuit] += 1;
        });
      return kept(attributes, (a) => {
        if (name !== "hopgraph.batch") return;
        const m = of(a);
        m.jobs += 1;
        m.keys += n(a["hopgraph.keys"]);
        m.hits += n(a["hopgraph.cache.hits"]) + n(a["hopgraph.inflight.hits"]);
        m.calls += n(a["hopgraph.calls"]);
        m.attempts += n(a["hopgraph.attempts"]);
        m.retries += n(a["hopgraph.retries"]);
        m.billedBytes += n(a["hopgraph.billed_bytes"]);
        m.ms += now() - started;
      });
    },
  };
  /** the share of a loader's keys the cache answered */
  const hitRatio = (loader: string) => {
    const m = loaders.get(loader);
    return m && m.keys > 0 ? m.hits / m.keys : 0;
  };
  return { tracer, loaders, hitRatio };
}
