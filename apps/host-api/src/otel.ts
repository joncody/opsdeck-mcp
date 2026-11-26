import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

type TraceContextState = {
  readonly traceId: string;
  readonly spanId: string;
};

type ExportSpanInput = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startEpochMs: number;
  readonly endEpochMs: number;
  readonly attributes: Readonly<Record<string, string>>;
  readonly isError?: boolean;
};

const traceStorage = new AsyncLocalStorage<TraceContextState>();
const DEFAULT_OTLP_HTTP_URL = "http://127.0.0.1:4318/v1/traces";

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function currentTraceparent(): string | undefined {
  const active = traceStorage.getStore();
  if (active === undefined) {
    return undefined;
  }
  return formatTraceparent(active.traceId, active.spanId);
}

function currentTraceContext(): TraceContextState | undefined {
  return traceStorage.getStore();
}

function runWithTraceContext<T>(state: TraceContextState, fn: () => Promise<T>): Promise<T> {
  return traceStorage.run(state, fn);
}

function toNanoString(epochMs: number): string {
  const wholeMs = Math.max(0, Math.round(epochMs));
  return `${BigInt(wholeMs) * 1_000_000n}`;
}

async function exportOtlpSpan(span: ExportSpanInput): Promise<void> {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEFAULT_OTLP_HTTP_URL;
  const attributes = Object.entries(span.attributes).map(function mapAttr(pair) {
    return {
      key: pair[0],
      value: { stringValue: pair[1] },
    };
  });

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "opsdeck-host-api" } },
            { key: "service.version", value: { stringValue: "0.1.0" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "opsdeck-host-api", version: "0.1.0" },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId,
                name: span.name,
                kind: 1,
                startTimeUnixNano: toNanoString(span.startEpochMs),
                endTimeUnixNano: toNanoString(span.endEpochMs),
                attributes,
                status: { code: span.isError === true ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-fatal if OTel Collector is not running locally
  }
}

export {
  currentTraceContext,
  currentTraceparent,
  exportOtlpSpan,
  newSpanId,
  newTraceId,
  runWithTraceContext,
};
export type { ExportSpanInput, TraceContextState };
