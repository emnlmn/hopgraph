// Runs the playlist example through examples/otel.ts, against an OpenTelemetry tracer that records
// what it is told: the spans nest as the run's do, attributes and events arrive as OpenTelemetry
// takes them, and a failure becomes an exception with a code and an error status.

import {
  type Attributes,
  type Context,
  type Exception,
  type Span as OtelSpan,
  type Tracer as OtelTracer,
  type SpanStatus,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { otel } from "./otel.ts";
import { example } from "./playlist.ts";

interface Told {
  readonly name: string;
  readonly attributes: Attributes;
  readonly events: { readonly name: string; readonly attributes: Attributes | undefined }[];
  readonly exceptions: Exception[];
  status: SpanStatus | undefined;
  readonly parent: Told | undefined;
  ended: boolean;
}

/** An OpenTelemetry tracer that keeps every span it starts, with its parent from the context. */
function recording(): { readonly tracer: OtelTracer; readonly spans: Told[] } {
  const spans: Told[] = [];
  const told = new WeakMap<OtelSpan, Told>();
  const startSpan = (name: string, options?: { attributes?: Attributes }, ctx?: Context) => {
    const above = ctx && trace.getSpan(ctx);
    const one: Told = {
      name,
      attributes: { ...options?.attributes },
      events: [],
      exceptions: [],
      status: undefined,
      parent: above && told.get(above),
      ended: false,
    };
    spans.push(one);
    const span: OtelSpan = {
      spanContext: () => ({
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      }),
      setAttribute: (key, value) => {
        Object.assign(one.attributes, { [key]: value });
        return span;
      },
      setAttributes: (attributes) => {
        Object.assign(one.attributes, attributes);
        return span;
      },
      addEvent: (event, attributes) => {
        one.events.push({ name: event, attributes: attributes as Attributes | undefined });
        return span;
      },
      addLink: () => span,
      addLinks: () => span,
      setStatus: (status) => {
        one.status = status;
        return span;
      },
      updateName: () => span,
      end: () => {
        one.ended = true;
      },
      isRecording: () => true,
      recordException: (exception) => {
        one.exceptions.push(exception);
      },
    };
    told.set(span, one);
    return span;
  };
  const tracer = {
    startSpan,
    startActiveSpan: () => {
      throw new Error("the adapter never starts an active span");
    },
  } as unknown as OtelTracer;
  return { tracer, spans };
}

describe("examples/otel", () => {
  it("each span of a run is an OpenTelemetry span, a child of the one it belongs to", async () => {
    const { tracer, spans } = recording();
    await example({ tracer: otel(tracer) });

    const [run, ...rest] = spans;
    expect(run?.name).toBe("hopgraph.run");
    expect(run?.parent).toBeUndefined();
    expect(run?.attributes).toMatchObject({ "hopgraph.rows": 5, "hopgraph.status": "complete" });
    const jobs = rest.filter((s) => s.name === "hopgraph.batch");
    expect(jobs.map((j) => j.attributes["hopgraph.loader"]).sort()).toEqual(["artists", "tracks"]);
    for (const job of jobs) {
      expect(job.parent).toBe(run);
      expect(Array.isArray(job.attributes["hopgraph.steps"])).toBe(true);
    }
    for (const span of rest.filter((s) => s.name !== "hopgraph.batch"))
      expect(jobs).toContain(span.parent);
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("a failure is an exception with its code and class, and an error status", () => {
    const { tracer, spans } = recording();
    const span = otel(tracer).startSpan("hopgraph.load", { "hopgraph.connectors": ["db"] });
    span.addEvent("hopgraph.retry", { "hopgraph.attempt": 2 });
    span.recordError({ code: "ECONNRESET", class: "Error" });
    span.end();

    expect(spans[0]?.attributes).toEqual({ "hopgraph.connectors": ["db"] });
    expect(spans[0]?.events).toEqual([
      { name: "hopgraph.retry", attributes: { "hopgraph.attempt": 2 } },
    ]);
    expect(spans[0]?.exceptions).toEqual([{ name: "Error", code: "ECONNRESET" }]);
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR, message: "ECONNRESET" });
  });
});
