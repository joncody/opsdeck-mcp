import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  ElicitationResumeRequest,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpServerSnapshot,
  McpToolDescriptor,
  TaskInfoResponse,
  TaskLifecycleStatus,
} from "@opsdeck/shared/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createOAuthTokenManager, type OAuthClientConfig } from "./oauth-client.js";
import { currentTraceparent } from "./otel.js";

type StdioServerSpec = {
  readonly serverId: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

type HttpServerSpec = {
  readonly serverId: string;
  readonly transport: "streamable-http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly oauth?: OAuthClientConfig;
};

type McpServerSpec = StdioServerSpec | HttpServerSpec;

type WireFrameEvent = {
  readonly serverId: string;
  readonly direction: "request" | "response";
  readonly method: string;
  readonly durationMs?: number;
  readonly payload: unknown;
};

type WireObserver = (event: WireFrameEvent) => void;

type ElicitationPrompt = {
  readonly elicitationId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly requestState?: string;
};

type ElicitationObserver = (prompt: ElicitationPrompt) => void;

type ElicitationFieldValue = string | number | boolean | string[];

type ElicitationDecision = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Readonly<Record<string, unknown>>;
};

type ToolCallCompleteResult = {
  readonly kind: "complete";
  readonly serverId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly contentText: string;
  readonly rawResult: unknown;
};

type ToolCallTaskResult = {
  readonly kind: "task";
  readonly serverId: string;
  readonly toolName: string;
  readonly durationMs: number;
  readonly task: TaskInfoResponse;
};

type ToolInvocationResult = ToolCallCompleteResult | ToolCallTaskResult;

type CallToolCallbacks = {
  readonly onWire?: WireObserver;
  readonly onElicitation?: ElicitationObserver;
};

type ActiveCallContext = {
  readonly toolName: string;
  readonly onElicitation?: ElicitationObserver;
};

type ConnectedServerEntry = {
  readonly spec: McpServerSpec;
  readonly client: Client;
  readonly snapshot: McpServerSnapshot;
  readonly setActiveCall: (ctx: ActiveCallContext | undefined) => void;
  readonly consumeCapturedTask: (requestId: string | number | undefined) => TaskInfoResponse | undefined;
  readonly consumeLastRequestState: () => string | undefined;
};

type McpPool = {
  readonly connectAll: () => Promise<readonly McpServerSnapshot[]>;
  readonly reconnectDegraded: () => Promise<readonly McpServerSnapshot[]>;
  readonly getSnapshots: () => readonly McpServerSnapshot[];
  readonly listAllTools: () => readonly McpToolDescriptor[];
  readonly callTool: (
    qualifiedName: string,
    args: Readonly<Record<string, unknown>>,
    callbacks?: CallToolCallbacks,
  ) => Promise<ToolInvocationResult>;
  readonly resolveElicitation: (request: ElicitationResumeRequest) => boolean;
  readonly getTask: (
    serverId: string,
    taskId: string,
    observer?: WireObserver,
  ) => Promise<TaskInfoResponse>;
  readonly cancelTask: (
    serverId: string,
    taskId: string,
    observer?: WireObserver,
  ) => Promise<void>;
  readonly readResource: (
    serverId: string,
    uri: string,
    observer?: WireObserver,
  ) => Promise<{ readonly uri: string; readonly mimeType?: string; readonly text: string }>;
  readonly getPrompt: (
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    observer?: WireObserver,
  ) => Promise<{
    readonly description?: string;
    readonly messages: readonly { readonly role: string; readonly text: string }[];
  }>;
  readonly closeAll: () => Promise<void>;
};

const QUALIFIED_SEPARATOR = "__";
const LooseObjectSchema = z.looseObject({});

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = "cause" in err && err.cause !== undefined ? `: ${String(err.cause)}` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}

function buildQualifiedName(serverId: string, toolName: string): string {
  return `${serverId}${QUALIFIED_SEPARATOR}${toolName}`;
}

function sanitizeElicitationContent(
  raw: Readonly<Record<string, unknown>> | undefined,
): Record<string, ElicitationFieldValue> {
  const sanitized: Record<string, ElicitationFieldValue> = {};
  if (raw === undefined) {
    return sanitized;
  }

  Object.entries(raw).forEach(function copyField(pair) {
    const key = pair[0];
    const val = pair[1];
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      sanitized[key] = val;
      return;
    }
    if (Array.isArray(val)) {
      sanitized[key] = val.filter(function isStr(item): item is string {
        return typeof item === "string";
      });
    }
  });

  return sanitized;
}

function extractTextFromContentBlocks(blocks: readonly unknown[]): string {
  const parts = blocks
    .map(function extractBlock(block): string | undefined {
      if (isPlainRecord(block) === false) {
        return undefined;
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .filter(function isDefined(value): value is string {
      return value !== undefined;
    });

  return parts.join("\n");
}

function extractPromptMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (isPlainRecord(content)) {
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    return JSON.stringify(content);
  }
  return String(content);
}

function normalizeTaskStatus(rawStatus: unknown): TaskLifecycleStatus {
  if (
    rawStatus === "working" ||
    rawStatus === "input_required" ||
    rawStatus === "completed" ||
    rawStatus === "failed" ||
    rawStatus === "cancelled"
  ) {
    return rawStatus;
  }
  return "working";
}

function parseTaskPayload(serverId: string, raw: unknown): TaskInfoResponse | undefined {
  if (isPlainRecord(raw) === false) {
    return undefined;
  }

  const candidate = isPlainRecord(raw.task) ? raw.task : raw;
  if (typeof candidate.taskId !== "string") {
    return undefined;
  }

  const pollRaw =
    typeof candidate.pollInterval === "number"
      ? candidate.pollInterval
      : typeof candidate.pollIntervalMs === "number"
        ? candidate.pollIntervalMs
        : undefined;

  let resultText: string | undefined;
  let isError: boolean | undefined;

  if (isPlainRecord(candidate.result)) {
    const blocks = Array.isArray(candidate.result.content) ? candidate.result.content : [];
    resultText = extractTextFromContentBlocks(blocks);
    isError = candidate.result.isError === true;
  } else if (Array.isArray(raw.content)) {
    resultText = extractTextFromContentBlocks(raw.content);
    isError = raw.isError === true;
  }

  return {
    serverId,
    taskId: candidate.taskId,
    status: normalizeTaskStatus(candidate.status),
    statusMessage:
      typeof candidate.statusMessage === "string" ? candidate.statusMessage : undefined,
    pollIntervalMs: pollRaw,
    resultText,
    isError,
  };
}

async function discoverServerCapabilities(
  spec: McpServerSpec,
  client: Client,
): Promise<McpServerSnapshot> {
  const era = client.getProtocolEra() === "modern" ? "modern" : "legacy";
  const toolsResult = await client.listTools();

  const tools: McpToolDescriptor[] = toolsResult.tools.map(function mapTool(tool) {
    return {
      serverId: spec.serverId,
      qualifiedName: buildQualifiedName(spec.serverId, tool.name),
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
    };
  });

  const resources: McpResourceDescriptor[] = [];
  try {
    const resourcesResult = await client.listResources();
    resourcesResult.resources.forEach(function pushResource(resource) {
      resources.push({
        serverId: spec.serverId,
        uri: resource.uri,
        name: resource.name,
        description: resource.description ?? undefined,
        mimeType: resource.mimeType ?? undefined,
      });
    });
  } catch {
    // Servers without resources capability omit resources/list
  }

  const resourceTemplates: McpResourceTemplateDescriptor[] = [];
  try {
    const templatesResult = await client.listResourceTemplates();
    templatesResult.resourceTemplates.forEach(function pushTemplate(template) {
      resourceTemplates.push({
        serverId: spec.serverId,
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description ?? undefined,
        mimeType: template.mimeType ?? undefined,
      });
    });
  } catch {
    // Servers without resourceTemplates capability omit resources/templates/list
  }

  const prompts: McpPromptDescriptor[] = [];
  try {
    const promptsResult = await client.listPrompts();
    promptsResult.prompts.forEach(function pushPrompt(prompt) {
      const mappedArgs = (prompt.arguments ?? []).map(function mapArg(arg) {
        return {
          name: arg.name,
          description: arg.description ?? undefined,
          required: arg.required ?? undefined,
        };
      });
      prompts.push({
        serverId: spec.serverId,
        name: prompt.name,
        description: prompt.description ?? undefined,
        arguments: mappedArgs,
      });
    });
  } catch {
    // Servers without prompts capability omit prompts/list
  }

  return {
    serverId: spec.serverId,
    transport: spec.transport,
    status: "connected",
    era,
    tools,
    resources,
    resourceTemplates,
    prompts,
  };
}

function createMcpPool(specs: readonly McpServerSpec[]): McpPool {
  const entries = Object.create(null) as Record<string, ConnectedServerEntry | undefined>;
  const failedSnapshots = Object.create(null) as Record<string, McpServerSnapshot | undefined>;
  const toolRouting = Object.create(null) as Record<
    string,
    { readonly serverId: string; readonly toolName: string } | undefined
  >;
  const pendingElicitations = Object.create(null) as Record<
    string,
    ((decision: ElicitationDecision) => void) | undefined
  >;

  function buildHttpCaptureTransport(spec: HttpServerSpec): {
    readonly transport: StreamableHTTPClientTransport;
    readonly consumeCapturedTask: () => TaskInfoResponse | undefined;
    readonly consumeLastRequestState: () => string | undefined;
  } {
    let lastCapturedTask: TaskInfoResponse | undefined;
    let lastCapturedRequestState: string | undefined;
    const tokenManager =
      spec.oauth !== undefined
        ? createOAuthTokenManager({
            mcpEndpointUrl: spec.url,
            config: spec.oauth,
          })
        : undefined;

    async function sendWithOptionalHeaders(
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      forceRefresh: boolean,
    ): Promise<Response> {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const traceparent = currentTraceparent();
      if (traceparent !== undefined) {
        headers.set("traceparent", traceparent);
      }
      if (tokenManager !== undefined) {
        const token = await tokenManager.getToken(forceRefresh);
        if (token !== undefined) {
          headers.set("authorization", `Bearer ${token}`);
        }
      }
      return fetch(input, { ...init, headers });
    }

    const wrappedFetch = async function captureJsonRpcFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let response = await sendWithOptionalHeaders(input, init, false);
      if (response.status === 401 && tokenManager !== undefined) {
        tokenManager.invalidate();
        response = await sendWithOptionalHeaders(input, init, true);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          const cloned = response.clone();
          const json: unknown = await cloned.json();
          if (isPlainRecord(json) && isPlainRecord(json.result)) {
            if (typeof json.result.requestState === "string") {
              lastCapturedRequestState = json.result.requestState;
            }
            if (json.result.resultType === "task") {
              const parsed = parseTaskPayload(spec.serverId, json.result);
              if (parsed !== undefined) {
                lastCapturedTask = parsed;
              }
            }
          }
        } catch {
          // Ignore non-JSON bodies
        }
      }
      return response;
    };

    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      fetch: wrappedFetch,
      requestInit:
        spec.headers !== undefined
          ? { headers: { ...spec.headers } }
          : undefined,
    });

    return {
      transport,
      consumeCapturedTask: function consumeTask() {
        const current = lastCapturedTask;
        lastCapturedTask = undefined;
        return current;
      },
      consumeLastRequestState: function consumeState() {
        const state = lastCapturedRequestState;
        lastCapturedRequestState = undefined;
        return state;
      },
    };
  }

  async function connectSingleServer(spec: McpServerSpec): Promise<McpServerSnapshot> {
    let activeCall: ActiveCallContext | undefined;

    const client = new Client(
      { name: "opsdeck-host-api", version: "0.1.0" },
      {
        versionNegotiation: { mode: "auto" },
        capabilities: {
          elicitation: { form: {} },
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
        inputRequired: {
          autoFulfill: true,
          maxRounds: 5,
        },
      },
    );

    const httpCapture =
      spec.transport === "streamable-http" ? buildHttpCaptureTransport(spec) : undefined;

    client.setRequestHandler("elicitation/create", async function handleElicit(request) {
      const elicitationId = randomUUID();
      const paramsRecord = request.params as Record<string, unknown>;
      const message =
        typeof paramsRecord.message === "string"
          ? paramsRecord.message
          : "Server requested operator confirmation";
      const requestedSchema = isPlainRecord(paramsRecord.requestedSchema)
        ? { ...paramsRecord.requestedSchema }
        : { type: "object", properties: {} };

      const requestState = httpCapture?.consumeLastRequestState();

      const decisionPromise = new Promise<ElicitationDecision>(function waitDecision(resolve) {
        pendingElicitations[elicitationId] = resolve;
      });

      activeCall?.onElicitation?.({
        elicitationId,
        serverId: spec.serverId,
        toolName: activeCall.toolName,
        message,
        requestedSchema,
        requestState,
      });

      const decision = await decisionPromise;
      if (decision.action !== "accept") {
        return { action: decision.action };
      }

      return {
        action: "accept",
        content: sanitizeElicitationContent(decision.content),
      };
    });

    try {
      const transport =
        httpCapture !== undefined
          ? httpCapture.transport
          : new StdioClientTransport({
              command: (spec as StdioServerSpec).command,
              args: [...(spec as StdioServerSpec).args],
              env:
                (spec as StdioServerSpec).env !== undefined
                  ? { ...(spec as StdioServerSpec).env }
                  : undefined,
              stderr: "inherit",
            });

      await client.connect(transport);
      const snapshot = await discoverServerCapabilities(spec, client);

      entries[spec.serverId] = {
        spec,
        client,
        snapshot,
        setActiveCall: function setCall(ctx) {
          activeCall = ctx;
        },
        consumeCapturedTask: function consumeTask() {
          return httpCapture?.consumeCapturedTask();
        },
        consumeLastRequestState: function consumeState() {
          return httpCapture?.consumeLastRequestState();
        },
      };
      delete failedSnapshots[spec.serverId];

      snapshot.tools.forEach(function registerTool(tool) {
        toolRouting[tool.qualifiedName] = {
          serverId: spec.serverId,
          toolName: tool.name,
        };
      });

      return snapshot;
    } catch (err) {
      const degraded: McpServerSnapshot = {
        serverId: spec.serverId,
        transport: spec.transport,
        status: "degraded",
        errorMessage: formatErrorMessage(err),
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
      };
      failedSnapshots[spec.serverId] = degraded;
      return degraded;
    }
  }

  async function connectAll(): Promise<readonly McpServerSnapshot[]> {
    const results: McpServerSnapshot[] = [];
    for (const spec of specs) {
      const snapshot = await connectSingleServer(spec);
      results.push(snapshot);
    }
    return results;
  }

  async function reconnectDegraded(): Promise<readonly McpServerSnapshot[]> {
    for (const spec of specs) {
      const connected = Object.hasOwn(entries, spec.serverId)
        ? entries[spec.serverId]
        : undefined;
      if (connected === undefined) {
        await connectSingleServer(spec);
      }
    }
    return getSnapshots();
  }

  function getSnapshots(): readonly McpServerSnapshot[] {
    return specs
      .map(function readSnapshot(spec): McpServerSnapshot | undefined {
        const connected = Object.hasOwn(entries, spec.serverId)
          ? entries[spec.serverId]
          : undefined;
        if (connected !== undefined) {
          return connected.snapshot;
        }
        return Object.hasOwn(failedSnapshots, spec.serverId)
          ? failedSnapshots[spec.serverId]
          : undefined;
      })
      .filter(function isPresent(item): item is McpServerSnapshot {
        return item !== undefined;
      });
  }

  function listAllTools(): readonly McpToolDescriptor[] {
    return getSnapshots().flatMap(function pickTools(snapshot) {
      return snapshot.tools;
    });
  }

  function resolveEntry(serverId: string): ConnectedServerEntry {
    const entry = Object.hasOwn(entries, serverId) ? entries[serverId] : undefined;
    if (entry === undefined) {
      throw new Error(`MCP server '${serverId}' is not connected`);
    }
    return entry;
  }

  async function callTool(
    qualifiedName: string,
    args: Readonly<Record<string, unknown>>,
    callbacks?: CallToolCallbacks,
  ): Promise<ToolInvocationResult> {
    const route = Object.hasOwn(toolRouting, qualifiedName)
      ? toolRouting[qualifiedName]
      : undefined;
    if (route === undefined) {
      throw new Error(`Unknown MCP tool '${qualifiedName}'`);
    }

    const entry = resolveEntry(route.serverId);
    const requestPayload = { name: route.toolName, arguments: { ...args } };
    callbacks?.onWire?.({
      serverId: route.serverId,
      direction: "request",
      method: "tools/call",
      payload: requestPayload,
    });

    entry.setActiveCall({
      toolName: route.toolName,
      onElicitation: callbacks?.onElicitation,
    });

    const startedAt = performance.now();
    try {
      const rawResult = await entry.client.callTool(requestPayload);
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

      callbacks?.onWire?.({
        serverId: route.serverId,
        direction: "response",
        method: "tools/call",
        durationMs,
        payload: rawResult,
      });

      const taskResult = parseTaskPayload(route.serverId, rawResult);
      if (taskResult !== undefined) {
        return {
          kind: "task",
          serverId: route.serverId,
          toolName: route.toolName,
          durationMs,
          task: taskResult,
        };
      }

      const resultRecord = rawResult as Record<string, unknown>;
      const blocks = Array.isArray(resultRecord.content) ? resultRecord.content : [];
      const contentText = extractTextFromContentBlocks(blocks);

      return {
        kind: "complete",
        serverId: route.serverId,
        toolName: route.toolName,
        isError: resultRecord.isError === true,
        durationMs,
        contentText,
        rawResult,
      };
    } catch (err) {
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const capturedTask = entry.consumeCapturedTask(undefined);
      if (capturedTask !== undefined) {
        callbacks?.onWire?.({
          serverId: route.serverId,
          direction: "response",
          method: "tools/call",
          durationMs,
          payload: { resultType: "task", task: capturedTask },
        });
        return {
          kind: "task",
          serverId: route.serverId,
          toolName: route.toolName,
          durationMs,
          task: capturedTask,
        };
      }
      throw err;
    } finally {
      entry.setActiveCall(undefined);
    }
  }

  function resolveElicitation(request: ElicitationResumeRequest): boolean {
    const resolver = Object.hasOwn(pendingElicitations, request.elicitationId)
      ? pendingElicitations[request.elicitationId]
      : undefined;
    if (resolver === undefined) {
      return false;
    }
    delete pendingElicitations[request.elicitationId];
    resolver({
      action: request.action,
      content: request.content,
    });
    return true;
  }

  async function getTask(
    serverId: string,
    taskId: string,
    observer?: WireObserver,
  ): Promise<TaskInfoResponse> {
    const entry = resolveEntry(serverId);
    observer?.({
      serverId,
      direction: "request",
      method: "tasks/get",
      payload: { taskId },
    });

    const startedAt = performance.now();
    const raw = await entry.client.request(
      { method: "tasks/get", params: { taskId } },
      LooseObjectSchema,
    );
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

    observer?.({
      serverId,
      direction: "response",
      method: "tasks/get",
      durationMs,
      payload: raw,
    });

    const parsed = parseTaskPayload(serverId, raw);
    if (parsed === undefined) {
      throw new Error(`Malformed tasks/get response for task '${taskId}'`);
    }
    return parsed;
  }

  async function cancelTask(
    serverId: string,
    taskId: string,
    observer?: WireObserver,
  ): Promise<void> {
    const entry = resolveEntry(serverId);
    observer?.({
      serverId,
      direction: "request",
      method: "tasks/cancel",
      payload: { taskId },
    });

    const startedAt = performance.now();
    const raw = await entry.client.request(
      { method: "tasks/cancel", params: { taskId } },
      LooseObjectSchema,
    );
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

    observer?.({
      serverId,
      direction: "response",
      method: "tasks/cancel",
      durationMs,
      payload: raw,
    });
  }

  async function readResource(
    serverId: string,
    uri: string,
    observer?: WireObserver,
  ): Promise<{ readonly uri: string; readonly mimeType?: string; readonly text: string }> {
    const entry = resolveEntry(serverId);
    observer?.({
      serverId,
      direction: "request",
      method: "resources/read",
      payload: { uri },
    });

    const startedAt = performance.now();
    const result = await entry.client.readResource({ uri });
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

    observer?.({
      serverId,
      direction: "response",
      method: "resources/read",
      durationMs,
      payload: result,
    });

    const first = result.contents[0];
    if (first === undefined) {
      throw new Error(`Resource '${uri}' returned empty contents`);
    }

    const text = "text" in first && typeof first.text === "string"
      ? first.text
      : JSON.stringify(first);

    return {
      uri: first.uri,
      mimeType: first.mimeType ?? undefined,
      text,
    };
  }

  async function getPrompt(
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    observer?: WireObserver,
  ): Promise<{
    readonly description?: string;
    readonly messages: readonly { readonly role: string; readonly text: string }[];
  }> {
    const entry = resolveEntry(serverId);
    const payload = { name, arguments: args !== undefined ? { ...args } : undefined };
    observer?.({
      serverId,
      direction: "request",
      method: "prompts/get",
      payload,
    });

    const startedAt = performance.now();
    const result = await entry.client.getPrompt(payload);
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

    observer?.({
      serverId,
      direction: "response",
      method: "prompts/get",
      durationMs,
      payload: result,
    });

    return {
      description: result.description ?? undefined,
      messages: result.messages.map(function mapMsg(message) {
        return {
          role: message.role,
          text: extractPromptMessageText(message.content),
        };
      }),
    };
  }

  async function closeAll(): Promise<void> {
    for (const spec of specs) {
      const entry = Object.hasOwn(entries, spec.serverId)
        ? entries[spec.serverId]
        : undefined;
      if (entry !== undefined) {
        await entry.client.close();
        delete entries[spec.serverId];
      }
    }
  }

  return Object.freeze({
    connectAll,
    reconnectDegraded,
    getSnapshots,
    listAllTools,
    callTool,
    resolveElicitation,
    getTask,
    cancelTask,
    readResource,
    getPrompt,
    closeAll,
  });
}

export { createMcpPool };
export type {
  CallToolCallbacks,
  ElicitationObserver,
  ElicitationPrompt,
  HttpServerSpec,
  McpPool,
  McpServerSpec,
  StdioServerSpec,
  ToolCallCompleteResult,
  ToolCallTaskResult,
  ToolInvocationResult,
  WireFrameEvent,
  WireObserver,
};
