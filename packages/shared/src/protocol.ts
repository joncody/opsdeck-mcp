import { z } from "zod";

const ModelProviderSchema = z.enum(["anthropic", "openai", "gemini", "mock"]);

const McpEraSchema = z.enum(["modern", "legacy"]);

const McpServerStatusSchema = z.enum(["connected", "degraded", "disconnected"]);

const TaskLifecycleStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

const McpToolDescriptorSchema = z.object({
  serverId: z.string().min(1),
  qualifiedName: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

const McpResourceDescriptorSchema = z.object({
  serverId: z.string().min(1),
  uri: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

const McpResourceTemplateDescriptorSchema = z.object({
  serverId: z.string().min(1),
  uriTemplate: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

const McpPromptArgumentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

const McpPromptDescriptorSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.array(McpPromptArgumentSchema),
});

const McpServerSnapshotSchema = z.object({
  serverId: z.string().min(1),
  transport: z.enum(["stdio", "streamable-http"]),
  status: McpServerStatusSchema,
  era: McpEraSchema.optional(),
  errorMessage: z.string().optional(),
  tools: z.array(McpToolDescriptorSchema),
  resources: z.array(McpResourceDescriptorSchema),
  resourceTemplates: z.array(McpResourceTemplateDescriptorSchema),
  prompts: z.array(McpPromptDescriptorSchema),
});

const AttachedResourceRefSchema = z.object({
  serverId: z.string().min(1),
  uri: z.string().min(1),
});

const ActivePromptRefSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.string()).optional(),
});

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const ChatTurnRequestSchema = z.object({
  provider: ModelProviderSchema.default("mock"),
  model: z.string().min(1).optional(),
  messages: z.array(ChatMessageSchema).min(1),
  attachedResources: z.array(AttachedResourceRefSchema).default([]),
  activePrompt: ActivePromptRefSchema.optional(),
  maxSteps: z.number().int().min(1).max(12).default(6),
});

const ElicitationResumeRequestSchema = z.object({
  elicitationId: z.string().min(1),
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});

const TaskInfoResponseSchema = z.object({
  serverId: z.string().min(1),
  taskId: z.string().min(1),
  status: TaskLifecycleStatusSchema,
  statusMessage: z.string().optional(),
  pollIntervalMs: z.number().optional(),
  resultText: z.string().optional(),
  isError: z.boolean().optional(),
});

const WireDirectionSchema = z.enum(["request", "response"]);

const HostSseEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("token"),
    traceId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    traceId: z.string(),
    step: z.number().int(),
    serverId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("tool_result"),
    traceId: z.string(),
    step: z.number().int(),
    serverId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    durationMs: z.number(),
    contentText: z.string(),
  }),
  z.object({
    kind: z.literal("wire_frame"),
    traceId: z.string(),
    serverId: z.string(),
    direction: WireDirectionSchema,
    method: z.string(),
    durationMs: z.number().optional(),
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal("trace_span"),
    traceId: z.string(),
    spanId: z.string(),
    name: z.string(),
    durationMs: z.number(),
    attributes: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal("elicitation_required"),
    traceId: z.string(),
    elicitationId: z.string(),
    serverId: z.string(),
    toolName: z.string(),
    message: z.string(),
    requestedSchema: z.record(z.string(), z.unknown()),
    requestState: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task_update"),
    traceId: z.string(),
    serverId: z.string(),
    taskId: z.string(),
    status: TaskLifecycleStatusSchema,
    statusMessage: z.string().optional(),
  }),
  z.object({
    kind: z.literal("done"),
    traceId: z.string(),
    finalText: z.string(),
    steps: z.number().int(),
  }),
  z.object({
    kind: z.literal("error"),
    traceId: z.string(),
    message: z.string(),
  }),
]);

type ModelProvider = z.infer<typeof ModelProviderSchema>;
type McpEra = z.infer<typeof McpEraSchema>;
type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
type TaskLifecycleStatus = z.infer<typeof TaskLifecycleStatusSchema>;
type McpToolDescriptor = z.infer<typeof McpToolDescriptorSchema>;
type McpResourceDescriptor = z.infer<typeof McpResourceDescriptorSchema>;
type McpResourceTemplateDescriptor = z.infer<typeof McpResourceTemplateDescriptorSchema>;
type McpPromptDescriptor = z.infer<typeof McpPromptDescriptorSchema>;
type McpServerSnapshot = z.infer<typeof McpServerSnapshotSchema>;
type AttachedResourceRef = z.infer<typeof AttachedResourceRefSchema>;
type ActivePromptRef = z.infer<typeof ActivePromptRefSchema>;
type ChatMessage = z.infer<typeof ChatMessageSchema>;
type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;
type ElicitationResumeRequest = z.infer<typeof ElicitationResumeRequestSchema>;
type TaskInfoResponse = z.infer<typeof TaskInfoResponseSchema>;
type HostSseEvent = z.infer<typeof HostSseEventSchema>;

export {
  ActivePromptRefSchema,
  AttachedResourceRefSchema,
  ChatMessageSchema,
  ChatTurnRequestSchema,
  ElicitationResumeRequestSchema,
  HostSseEventSchema,
  McpEraSchema,
  McpPromptArgumentSchema,
  McpPromptDescriptorSchema,
  McpResourceDescriptorSchema,
  McpResourceTemplateDescriptorSchema,
  McpServerSnapshotSchema,
  McpServerStatusSchema,
  McpToolDescriptorSchema,
  ModelProviderSchema,
  TaskInfoResponseSchema,
  TaskLifecycleStatusSchema,
};

export type {
  ActivePromptRef,
  AttachedResourceRef,
  ChatMessage,
  ChatTurnRequest,
  ElicitationResumeRequest,
  HostSseEvent,
  McpEra,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpServerSnapshot,
  McpServerStatus,
  McpToolDescriptor,
  ModelProvider,
  TaskInfoResponse,
  TaskLifecycleStatus,
};
