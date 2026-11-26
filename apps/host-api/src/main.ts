import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import {
  ChatTurnRequestSchema,
  ElicitationResumeRequestSchema,
} from "@opsdeck/shared/protocol";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { resolve } from "node:path";
import { z } from "zod";
import { runAgentTurn } from "./agent-loop.js";
import { createLlmRouter } from "./llm-router.js";
import { createMcpPool, type McpServerSpec } from "./mcp-pool.js";

const PromptRequestSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.string()).optional(),
});

const DEFAULT_OPS_HTTP_URL = "http://127.0.0.1:8090/mcp";
const DEFAULT_CIMD_CLIENT_ID = "https://host.opsdeck.dev/oauth/client-metadata.json";
const DEFAULT_OPS_SCOPES = "ops:read ops:incident:write ops:deploy:rollback";

function buildServerSpecs(): readonly McpServerSpec[] {
  const specs: McpServerSpec[] = [];

  if (process.env.MCP_TRANSPORT === "stdio" || process.env.OPS_SERVER_CMD !== undefined) {
    const defaultBinary = resolve(process.cwd(), "../../target/debug/opsdeck-server-ops");
    const command = process.env.OPS_SERVER_CMD ?? defaultBinary;
    specs.push({
      serverId: "server-ops",
      transport: "stdio",
      command,
      args: ["--stdio"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(function hasVal(
            entry,
          ): entry is [string, string] {
            return entry[1] !== undefined;
          }),
        ),
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgres://opsdeck:opsdeck@127.0.0.1:5432/opsdeck",
      },
    });
  } else {
    const opsUrl = process.env.OPS_SERVER_URL ?? DEFAULT_OPS_HTTP_URL;
    specs.push({
      serverId: "server-ops",
      transport: "streamable-http",
      url: opsUrl.trim(),
      oauth: {
        clientId: process.env.MCP_OAUTH_CLIENT_ID ?? DEFAULT_CIMD_CLIENT_ID,
        scopes: process.env.MCP_OAUTH_SCOPES ?? DEFAULT_OPS_SCOPES,
        subject: "opsdeck-host-api",
      },
    });
  }

  const communityUrl = process.env.COMMUNITY_MCP_URL;
  const communityCmd = process.env.COMMUNITY_MCP_CMD;
  if (communityUrl !== undefined && communityUrl.trim().length > 0) {
    specs.push({
      serverId: "community",
      transport: "streamable-http",
      url: communityUrl.trim(),
    });
  } else if (communityCmd !== undefined && communityCmd.trim().length > 0) {
    const rawArgs = process.env.COMMUNITY_MCP_ARGS ?? "";
    const parsedArgs = rawArgs.trim().length > 0 ? rawArgs.trim().split(/\s+/) : [];
    specs.push({
      serverId: "community",
      transport: "stdio",
      command: communityCmd.trim(),
      args: parsedArgs,
    });
  }

  return specs;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function bootstrap(): Promise<void> {
  const pool = createMcpPool(buildServerSpecs());
  const snapshots = await pool.connectAll();
  snapshots.forEach(function logServer(snapshot) {
    console.log(
      `[host-api] server=${snapshot.serverId} transport=${snapshot.transport} status=${snapshot.status} era=${snapshot.era ?? "n/a"} tools=${snapshot.tools.length}`,
    );
    if (snapshot.errorMessage !== undefined) {
      console.warn(`[host-api] server=${snapshot.serverId} warning=${snapshot.errorMessage}`);
    }
  });

  const llmRouter = createLlmRouter();
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    }),
  );

  app.get("/api/health", function handleHealth(c) {
    return c.json({
      ok: true,
      servers: pool.getSnapshots().map(function summarize(s) {
        return {
          serverId: s.serverId,
          transport: s.transport,
          status: s.status,
          era: s.era,
        };
      }),
    });
  });

  app.get("/api/servers", async function handleServers(c) {
    const current = pool.getSnapshots();
    const hasDegraded = current.some(function isDegraded(s) {
      return s.status !== "connected";
    });
    const servers = hasDegraded ? await pool.reconnectDegraded() : current;
    return c.json({ servers });
  });

  app.post("/api/servers/reconnect", async function handleReconnect(c) {
    const servers = await pool.reconnectDegraded();
    return c.json({ servers });
  });

  app.get("/api/tools", function handleTools(c) {
    return c.json({ tools: pool.listAllTools() });
  });

  app.get("/api/resources/read", async function handleReadResource(c) {
    const serverId = c.req.query("serverId") ?? "server-ops";
    const uri = c.req.query("uri");
    if (uri === undefined || uri.trim().length === 0) {
      return c.json({ error: "Missing required query parameter 'uri'" }, 400);
    }

    try {
      const resource = await pool.readResource(serverId, uri);
      return c.json(resource);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.post("/api/prompts/get", zValidator("json", PromptRequestSchema), async function handleGetPrompt(c) {
    const body = c.req.valid("json");
    try {
      const prompt = await pool.getPrompt(body.serverId, body.name, body.arguments);
      return c.json(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.post(
    "/api/elicit/resume",
    zValidator("json", ElicitationResumeRequestSchema),
    function handleElicitResume(c) {
      const body = c.req.valid("json");
      const matched = pool.resolveElicitation(body);
      if (matched === false) {
        return c.json({ error: `Unknown or expired elicitationId '${body.elicitationId}'` }, 404);
      }
      return c.json({ ok: true, elicitationId: body.elicitationId });
    },
  );

  app.get("/api/tasks/:serverId/:taskId", async function handleGetTask(c) {
    const serverId = c.req.param("serverId");
    const taskId = c.req.param("taskId");
    try {
      const task = await pool.getTask(serverId, taskId);
      return c.json(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.post("/api/tasks/:serverId/:taskId/cancel", async function handleCancelTask(c) {
    const serverId = c.req.param("serverId");
    const taskId = c.req.param("taskId");
    try {
      await pool.cancelTask(serverId, taskId);
      return c.json({ ok: true, serverId, taskId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.get("/api/ops/snapshot", async function handleOpsSnapshot(c) {
    try {
      await pool.reconnectDegraded();
      const [servicesRes, incidentsRes, runbooksRes, deploymentsRes] = await Promise.all([
        pool.readResource("server-ops", "ops://services"),
        pool.readResource("server-ops", "ops://incidents/open"),
        pool.readResource("server-ops", "ops://runbooks"),
        pool.callTool("server-ops__list_deployments", { limit: 12 }),
      ]);

      const deploymentsText =
        deploymentsRes.kind === "complete" ? deploymentsRes.contentText : "[]";

      return c.json({
        services: safeParseJson(servicesRes.text),
        incidents: safeParseJson(incidentsRes.text),
        runbooks: safeParseJson(runbooksRes.text),
        deployments: safeParseJson(deploymentsText),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.post("/api/chat", zValidator("json", ChatTurnRequestSchema), function handleChat(c) {
    const request = c.req.valid("json");
    return streamSSE(c, async function streamChatEvents(stream) {
      await runAgentTurn({
        request,
        pool,
        llmRouter,
        emit: async function emitSse(event) {
          await stream.writeSSE({
            event: event.kind,
            data: JSON.stringify(event),
          });
        },
      });
    });
  });

  const port = Number(process.env.PORT ?? "3001");
  const server = serve({ fetch: app.fetch, port }, function onListen(info) {
    console.log(`[host-api] listening on http://localhost:${info.port}`);
  });

  async function shutdown(): Promise<void> {
    console.log("[host-api] shutting down...");
    server.close();
    await pool.closeAll();
    process.exit(0);
  }

  process.on("SIGINT", function onSigInt() {
    void shutdown();
  });
  process.on("SIGTERM", function onSigTerm() {
    void shutdown();
  });
}

void bootstrap();
