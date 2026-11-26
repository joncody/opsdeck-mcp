import type { HostSseEvent } from "@opsdeck/shared/protocol";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { fetchOpsSnapshot, fetchServers } from "./api/hostClient";
import { ChatConsole } from "./components/ChatConsole";
import { InspectorPane, type TraceEntry, type WireEntry } from "./components/InspectorPane";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

function OpsDeckWorkspace() {
  const client = useQueryClient();
  const [wireEntries, setWireEntries] = useState<readonly WireEntry[]>([]);
  const [traceEntries, setTraceEntries] = useState<readonly TraceEntry[]>([]);
  const [chatDraft, setChatDraft] = useState<string | undefined>(undefined);

  const serversQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: fetchServers,
    refetchInterval: 30_000,
  });

  const snapshotQuery = useQuery({
    queryKey: ["ops-snapshot"],
    queryFn: fetchOpsSnapshot,
    refetchInterval: 15_000,
  });

  function handleTelemetryEvent(event: HostSseEvent): void {
    if (event.kind === "wire_frame") {
      setWireEntries(function prependWire(prev) {
        return [{ ...event, id: crypto.randomUUID() }, ...prev].slice(0, 60);
      });
      return;
    }
    if (event.kind === "trace_span") {
      setTraceEntries(function prependSpan(prev) {
        return [{ ...event, id: crypto.randomUUID() }, ...prev].slice(0, 60);
      });
    }
  }

  function handleTurnComplete(): void {
    void client.invalidateQueries({ queryKey: ["ops-snapshot"] });
  }

  function handleClearTelemetry(): void {
    setWireEntries([]);
    setTraceEntries([]);
  }

  async function handleRefreshSnapshot(): Promise<void> {
    await Promise.all([snapshotQuery.refetch(), serversQuery.refetch()]);
  }

  const servers = serversQuery.data ?? [];
  const snapshotError =
    snapshotQuery.error instanceof Error
      ? snapshotQuery.error.message
      : snapshotQuery.error !== undefined && snapshotQuery.error !== null
        ? String(snapshotQuery.error)
        : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 text-cyan-400" />
          <div>
            <h1 className="text-sm font-bold tracking-tight text-slate-100">OpsDeck MCP</h1>
            <p className="text-[11px] text-slate-400">
              2026-07-28 Stateless MCP Control Plane · Rust + TypeScript + Postgres
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {servers.map(function renderBadge(srv) {
            const connected = srv.status === "connected";
            return (
              <span
                key={srv.serverId}
                className={
                  connected
                    ? "inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] text-emerald-300"
                    : "inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 font-mono text-[11px] text-amber-300"
                }
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`}
                />
                {srv.serverId} ({srv.era ?? srv.status} · {srv.transport})
              </span>
            );
          })}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
        <div className="min-h-0 lg:col-span-7">
          <ChatConsole
            servers={servers}
            externalDraft={chatDraft}
            onClearExternalDraft={function clearDraft() {
              setChatDraft(undefined);
            }}
            onTelemetryEvent={handleTelemetryEvent}
            onTurnComplete={handleTurnComplete}
          />
        </div>
        <div className="min-h-0 lg:col-span-5">
          <InspectorPane
            servers={servers}
            snapshot={snapshotQuery.data}
            snapshotError={snapshotError}
            isSnapshotLoading={snapshotQuery.isFetching || serversQuery.isFetching}
            wireEntries={wireEntries}
            traceEntries={traceEntries}
            onRefreshSnapshot={handleRefreshSnapshot}
            onClearTelemetry={handleClearTelemetry}
            onSeedChatPrompt={function seedPrompt(text) {
              setChatDraft(text);
            }}
          />
        </div>
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <OpsDeckWorkspace />
    </QueryClientProvider>
  );
}

export { App };
