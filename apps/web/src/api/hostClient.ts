import {
  HostSseEventSchema,
  McpServerSnapshotSchema,
  type ChatTurnRequest,
  type ElicitationResumeRequest,
  type HostSseEvent,
  type McpServerSnapshot,
} from "@opsdeck/shared/protocol";
import { z } from "zod";

const ServiceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.string(),
  ownerTeam: z.string(),
  repoUrl: z.string(),
  status: z.string(),
  currentVersion: z.string(),
  updatedAt: z.string(),
});

const DeploymentRecordSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  version: z.string(),
  environment: z.string(),
  status: z.string(),
  deployedBy: z.string(),
  commitSha: z.string(),
  notes: z.string(),
  deployedAt: z.string(),
});

const IncidentRecordSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  title: z.string(),
  severity: z.string(),
  status: z.string(),
  summary: z.string(),
  commander: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().optional(),
});

const RunbookIndexItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  category: z.string(),
  uri: z.string(),
  updatedAt: z.string(),
});

const ServersResponseSchema = z.object({
  servers: z.array(McpServerSnapshotSchema),
});

const OpsSnapshotSchema = z.object({
  services: z.array(ServiceRecordSchema),
  incidents: z.array(IncidentRecordSchema),
  runbooks: z.array(RunbookIndexItemSchema),
  deployments: z.array(DeploymentRecordSchema),
  fetchedAt: z.string(),
});

const ResourceReadResponseSchema = z.object({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string(),
});

const PromptReadResponseSchema = z.object({
  description: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      text: z.string(),
    }),
  ),
});

const OkResponseSchema = z.object({
  ok: z.boolean(),
});

type ServiceRecord = z.infer<typeof ServiceRecordSchema>;
type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;
type IncidentRecord = z.infer<typeof IncidentRecordSchema>;
type RunbookIndexItem = z.infer<typeof RunbookIndexItemSchema>;
type OpsSnapshot = z.infer<typeof OpsSnapshotSchema>;
type ResourceReadResponse = z.infer<typeof ResourceReadResponseSchema>;
type PromptReadResponse = z.infer<typeof PromptReadResponseSchema>;

async function fetchTypedJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url);
  if (response.ok === false) {
    throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`);
  }
  const raw: unknown = await response.json();
  return schema.parse(raw);
}

async function postTypedJson<T>(
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok === false) {
    throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`);
  }
  const raw: unknown = await response.json();
  return schema.parse(raw);
}

async function fetchServers(): Promise<readonly McpServerSnapshot[]> {
  const result = await fetchTypedJson("/api/servers", ServersResponseSchema);
  return result.servers;
}

async function fetchOpsSnapshot(): Promise<OpsSnapshot> {
  return fetchTypedJson("/api/ops/snapshot", OpsSnapshotSchema);
}

async function readMcpResource(serverId: string, uri: string): Promise<ResourceReadResponse> {
  const query = new URLSearchParams({ serverId, uri });
  return fetchTypedJson(`/api/resources/read?${query.toString()}`, ResourceReadResponseSchema);
}

async function previewMcpPrompt(params: {
  readonly serverId: string;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, string>>;
}): Promise<PromptReadResponse> {
  return postTypedJson("/api/prompts/get", params, PromptReadResponseSchema);
}

async function resumeElicitation(request: ElicitationResumeRequest): Promise<void> {
  await postTypedJson("/api/elicit/resume", request, OkResponseSchema);
}

async function cancelMcpTask(serverId: string, taskId: string): Promise<void> {
  const path = `/api/tasks/${encodeURIComponent(serverId)}/${encodeURIComponent(taskId)}/cancel`;
  await postTypedJson(path, {}, OkResponseSchema);
}

function parseSseBlock(block: string): HostSseEvent | undefined {
  const dataLines = block
    .split("\n")
    .filter(function isDataLine(line) {
      return line.startsWith("data:");
    })
    .map(function stripPrefix(line) {
      return line.slice(5).trimStart();
    });

  if (dataLines.length === 0) {
    return undefined;
  }

  const rawJson = dataLines.join("\n");
  const parsedJson: unknown = JSON.parse(rawJson);
  const validated = HostSseEventSchema.safeParse(parsedJson);
  if (validated.success === false) {
    return undefined;
  }
  return validated.data;
}

async function streamChatTurn(params: {
  readonly request: ChatTurnRequest;
  readonly onEvent: (event: HostSseEvent) => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params.request),
    signal: params.signal,
  });

  if (response.ok === false) {
    throw new Error(`Chat request failed (${response.status}): ${await response.text()}`);
  }

  if (response.body === null) {
    throw new Error("Streaming response body was unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const normalized = buffer.replaceAll("\r\n", "\n");
    const parts = normalized.split("\n\n");
    const trailing = parts.pop();
    buffer = trailing ?? "";

    parts.forEach(function emitBlock(block) {
      const trimmed = block.trim();
      if (trimmed.length === 0) {
        return;
      }
      const event = parseSseBlock(trimmed);
      if (event !== undefined) {
        params.onEvent(event);
      }
    });
  }

  const remainder = buffer.trim();
  if (remainder.length > 0) {
    const tailEvent = parseSseBlock(remainder);
    if (tailEvent !== undefined) {
      params.onEvent(tailEvent);
    }
  }
}

export {
  cancelMcpTask,
  fetchOpsSnapshot,
  fetchServers,
  previewMcpPrompt,
  readMcpResource,
  resumeElicitation,
  streamChatTurn,
};

export type {
  DeploymentRecord,
  IncidentRecord,
  OpsSnapshot,
  PromptReadResponse,
  ResourceReadResponse,
  RunbookIndexItem,
  ServiceRecord,
};
