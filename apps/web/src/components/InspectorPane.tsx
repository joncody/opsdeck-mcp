import type { HostSseEvent, McpServerSnapshot } from "@opsdeck/shared/protocol";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  GitBranch,
  Layers,
  Play,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  readMcpResource,
  type OpsSnapshot,
  type ResourceReadResponse,
} from "../api/hostClient";

type WireEntry = Extract<HostSseEvent, { readonly kind: "wire_frame" }> & {
  readonly id: string;
};

type TraceEntry = Extract<HostSseEvent, { readonly kind: "trace_span" }> & {
  readonly id: string;
};

type InspectorPaneProps = {
  readonly servers: readonly McpServerSnapshot[];
  readonly snapshot?: OpsSnapshot;
  readonly snapshotError?: string;
  readonly isSnapshotLoading: boolean;
  readonly wireEntries: readonly WireEntry[];
  readonly traceEntries: readonly TraceEntry[];
  readonly onRefreshSnapshot: () => Promise<void>;
  readonly onClearTelemetry: () => void;
  readonly onSeedChatPrompt: (text: string) => void;
};

const STATUS_BADGES: Readonly<Record<string, string>> = Object.freeze({
  healthy: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  degraded: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  down: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  sev1: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  sev2: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  sev3: "border-sky-500/40 bg-sky-500/15 text-sky-300",
  sev4: "border-slate-600 bg-slate-800 text-slate-300",
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rolled_back: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-300",
} as const);

function badgeStyle(key: string): string {
  return STATUS_BADGES[key] ?? "border-slate-700 bg-slate-800 text-slate-300";
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, ms);
  });
}

function InspectorPane(props: InspectorPaneProps) {
  const [activeTab, setActiveTab] = useState<"ops" | "wire">("ops");
  const [selectedRunbook, setSelectedRunbook] = useState<ResourceReadResponse | undefined>(
    undefined,
  );
  const [runbookError, setRunbookError] = useState<string | undefined>(undefined);
  const [isManualRefreshing, setIsManualRefreshing] = useState<boolean>(false);

  const telemetryCount = props.wireEntries.length + props.traceEntries.length;
  const isRefreshing = props.isSnapshotLoading || isManualRefreshing;

  async function openRunbook(uri: string): Promise<void> {
    setRunbookError(undefined);
    try {
      const data = await readMcpResource("server-ops", uri);
      setSelectedRunbook(data);
    } catch (err) {
      setRunbookError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleManualRefresh(): Promise<void> {
    if (isManualRefreshing) {
      return;
    }
    setIsManualRefreshing(true);
    try {
      await Promise.all([props.onRefreshSnapshot(), sleepMs(350)]);
    } finally {
      setIsManualRefreshing(false);
    }
  }

  return (
    <section className="flex h-full flex-col border-l border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-2">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={function selectOpsTab() {
              setActiveTab("ops");
            }}
            className={
              activeTab === "ops"
                ? "inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-cyan-300"
                : "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
            }
          >
            <Database className="h-3.5 w-3.5" />
            Postgres Ops State
          </button>

          <button
            type="button"
            onClick={function selectWireTab() {
              setActiveTab("wire");
            }}
            className={
              activeTab === "wire"
                ? "inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-cyan-300"
                : "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
            }
          >
            <Activity className="h-3.5 w-3.5" />
            MCP Wire &amp; Traces
            <span className="rounded-full bg-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
              {props.wireEntries.length}
            </span>
          </button>
        </div>

        {activeTab === "ops" ? (
          <button
            type="button"
            disabled={isRefreshing}
            onClick={function handleRefresh() {
              void handleManualRefresh();
            }}
            title="Refresh live Postgres state and MCP server status"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin text-cyan-400" : ""}`} />
            {isRefreshing ? "Syncing..." : "Refresh"}
          </button>
        ) : (
          <button
            type="button"
            disabled={telemetryCount === 0}
            onClick={function handleClear() {
              props.onClearTelemetry();
            }}
            title={
              telemetryCount === 0
                ? "No trace spans or JSON-RPC wire frames to clear"
                : "Clear captured trace spans and JSON-RPC wire frames"
            }
            className="inline-flex cursor-pointer items-center gap-1 rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-rose-500 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            {telemetryCount > 0 ? `Clear (${telemetryCount})` : "Clear"}
          </button>
        )}
      </div>

      {activeTab === "ops" ? (
        <div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
          {props.snapshotError !== undefined ? (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">
              <div className="font-semibold text-rose-300">Failed to sync Postgres Ops State</div>
              <div className="mt-1 font-mono text-[11px]">{props.snapshotError}</div>
            </div>
          ) : undefined}

          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              <span className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-cyan-400" />
                Services ({props.snapshot?.services.length ?? 0})
              </span>
              {props.snapshot !== undefined ? (
                <span className="font-mono text-[10px] font-normal text-slate-400">
                  synced {new Date(props.snapshot.fetchedAt).toLocaleTimeString()}
                </span>
              ) : undefined}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(props.snapshot?.services ?? []).map(function renderService(service) {
                return (
                  <div
                    key={service.id}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold text-slate-100">{service.name}</span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${badgeStyle(service.status)}`}
                      >
                        {service.status}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
                      <span className="font-mono text-cyan-300">{service.currentVersion}</span>
                      <span>
                        {service.tier} · {service.ownerTeam}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              Active Incidents ({props.snapshot?.incidents.length ?? 0})
            </div>
            <div className="space-y-2">
              {(props.snapshot?.incidents ?? []).map(function renderIncident(incident) {
                return (
                  <div
                    key={incident.id}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${badgeStyle(incident.severity)}`}
                          >
                            {incident.severity}
                          </span>
                          <span className="font-mono text-cyan-300">{incident.serviceName}</span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                            {incident.status}
                          </span>
                        </div>
                        <div className="font-medium text-slate-100">{incident.title}</div>
                      </div>
                      <button
                        type="button"
                        onClick={function triageInChat() {
                          props.onSeedChatPrompt(
                            `Triage incident ${incident.id} on ${incident.serviceName}: ${incident.title}`,
                          );
                        }}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[10px] font-medium text-cyan-300 hover:bg-cyan-500/20"
                      >
                        <Play className="h-2.5 w-2.5" />
                        Triage
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                      {incident.summary}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              <GitBranch className="h-3.5 w-3.5 text-emerald-400" />
              Recent Deployments
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-800">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-slate-900 text-slate-400">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">Service</th>
                    <th className="px-2.5 py-1.5 font-medium">Version</th>
                    <th className="px-2.5 py-1.5 font-medium">Status</th>
                    <th className="px-2.5 py-1.5 font-medium">Commit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 bg-slate-950">
                  {(props.snapshot?.deployments ?? []).slice(0, 8).map(function renderDep(dep) {
                    return (
                      <tr key={dep.id}>
                        <td className="px-2.5 py-1.5 font-mono text-slate-200">{dep.serviceName}</td>
                        <td className="px-2.5 py-1.5 font-mono text-cyan-300">{dep.version}</td>
                        <td className="px-2.5 py-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] ${badgeStyle(dep.status)}`}
                          >
                            {dep.status}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-slate-400">{dep.commitSha}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              <BookOpen className="h-3.5 w-3.5 text-sky-400" />
              Runbooks (MCP Resources)
            </div>
            <div className="space-y-1.5">
              {(props.snapshot?.runbooks ?? []).map(function renderRunbook(rb) {
                return (
                  <button
                    key={rb.slug}
                    type="button"
                    onClick={function loadRunbook() {
                      void openRunbook(rb.uri);
                    }}
                    className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-left hover:border-cyan-500/50"
                  >
                    <div>
                      <div className="font-medium text-slate-200">{rb.title}</div>
                      <div className="font-mono text-[10px] text-cyan-400">{rb.uri}</div>
                    </div>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {rb.category}
                    </span>
                  </button>
                );
              })}
            </div>

            {runbookError !== undefined ? (
              <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
                {runbookError}
              </div>
            ) : undefined}

            {selectedRunbook !== undefined ? (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] text-cyan-300">{selectedRunbook.uri}</span>
                  <button
                    type="button"
                    onClick={function closeRunbook() {
                      setSelectedRunbook(undefined);
                    }}
                    className="cursor-pointer text-slate-400 hover:text-slate-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">
                  {selectedRunbook.text}
                </pre>
              </div>
            ) : undefined}
          </div>
        </div>
      ) : (
        <div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              <Layers className="h-3.5 w-3.5 text-cyan-400" />
              Connected MCP Servers
            </div>
            <div className="space-y-2">
              {props.servers.map(function renderServer(srv) {
                const ok = srv.status === "connected";
                return (
                  <div
                    key={srv.serverId}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-mono font-semibold text-slate-100">
                        <CheckCircle2
                          className={`h-3.5 w-3.5 ${ok ? "text-emerald-400" : "text-amber-400"}`}
                        />
                        {srv.serverId}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                          {srv.transport}
                        </span>
                        {srv.era !== undefined ? (
                          <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                            {srv.era === "modern" ? "2026-07-28 modern" : "legacy"}
                          </span>
                        ) : undefined}
                      </div>
                    </div>
                    <div className="mt-1.5 text-[11px] text-slate-400">
                      {srv.tools.length} tools · {srv.resources.length} resources ·{" "}
                      {srv.resourceTemplates.length} templates · {srv.prompts.length} prompts
                    </div>
                    {srv.errorMessage !== undefined ? (
                      <div className="mt-1.5 font-mono text-[11px] text-amber-300">
                        {srv.errorMessage}
                      </div>
                    ) : undefined}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              Trace Spans ({props.traceEntries.length})
            </div>
            <div className="space-y-1.5">
              {props.traceEntries.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-slate-500">
                  Run a chat turn to inspect live LLM + MCP trace spans.
                </div>
              ) : (
                props.traceEntries.map(function renderSpan(span) {
                  const barWidth = Math.min(100, Math.max(4, Math.round(span.durationMs * 2)));
                  return (
                    <div
                      key={span.id}
                      className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2"
                    >
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="text-slate-200">{span.name}</span>
                        <span className="text-cyan-300">{span.durationMs}ms</span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-cyan-500"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              JSON-RPC Wire Frames ({props.wireEntries.length})
            </div>
            <div className="space-y-2">
              {props.wireEntries.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-slate-500">
                  Run a chat turn to capture live MCP JSON-RPC requests and responses.
                </div>
              ) : (
                props.wireEntries.map(function renderWire(frame) {
                  const isReq = frame.direction === "request";
                  return (
                    <div
                      key={frame.id}
                      className="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5 font-mono text-[11px]"
                    >
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={
                              isReq
                                ? "rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-300"
                                : "rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300"
                            }
                          >
                            {frame.direction.toUpperCase()}
                          </span>
                          <span className="text-slate-200">{frame.method}</span>
                        </span>
                        <span className="text-slate-400">
                          {frame.serverId}
                          {frame.durationMs !== undefined ? ` · ${frame.durationMs}ms` : ""}
                        </span>
                      </div>
                      <pre className="max-h-40 overflow-auto rounded bg-slate-950 p-2 text-[10px] text-slate-300">
                        {JSON.stringify(frame.payload, undefined, 2)}
                      </pre>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export { InspectorPane };
export type { TraceEntry, WireEntry };
