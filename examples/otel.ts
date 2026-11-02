// Hopgraph's spans as OpenTelemetry spans. `otel(tracer)` adapts an OpenTelemetry tracer to the
// `Tracer` a run takes: each run, job, dry run, call and cache read or write becomes an
// OpenTelemetry span, a child of the one it belongs to, with its attributes, its retries as
// events, and its failures as exceptions that carry a code and a class (Hopgraph hands over no
// message). The library does not depend on OpenTelemetry: this file is an example to adapt.
//
//   import { trace } from "@opentelemetry/api";
//   const runner = createRunner(graph, { ...env, tracer: otel(trace.getTracer("hopgraph")) });
//
// examples/otel.test.ts runs it against a tracer that records what OpenTelemetry is told.

import {
  type Attributes,
  context,
  type Span as OtelSpan,
  type Tracer as OtelTracer,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Span, SpanAttributes, Tracer } from "hopgraph";

export function otel(tracer: OtelTracer): Tracer {
  const spans = new WeakMap<Span, OtelSpan>();
  return {
    startSpan(name, attributes, parent) {
      const above = parent && spans.get(parent);
      const ctx = above ? trace.setSpan(context.active(), above) : context.active();
      const span = tracer.startSpan(name, { attributes: plain(attributes) }, ctx);
      const ours: Span = {
        setAttribute: (key, value) => void span.setAttributes(plain({ [key]: value })),
        addEvent: (event, attrs) => void span.addEvent(event, plain(attrs)),
        recordError: (error) => {
          span.recordException({ name: error.class ?? error.code, code: error.code });
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.code });
        },
        end: () => span.end(),
      };
      spans.set(ours, span);
      return ours;
    },
  };
}

/** OpenTelemetry's attributes take mutable arrays. */
const plain = (attributes: SpanAttributes = {}): Attributes =>
  Object.fromEntries(
    Object.entries(attributes).map(([k, v]) => [k, typeof v === "object" ? [...v] : v]),
  );
