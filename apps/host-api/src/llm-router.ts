import type { McpToolDescriptor, ModelProvider } from "@opsdeck/shared/protocol";
import { z } from "zod";

type LlmToolCall = {
  readonly id: string;
  readonly qualifiedName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};

type LlmTurnMessage =
  | { readonly role: "system" | "user" | "assistant"; readonly content: string }
  | { readonly role: "assistant_tool_calls"; readonly calls: readonly LlmToolCall[] }
  | {
      readonly role: "tool_result";
      readonly toolCallId: string;
      readonly qualifiedName: string;
      readonly content: string;
      readonly isError: boolean;
    };

type TextTurnMessage = Extract<LlmTurnMessage, { readonly content: string }>;

type LlmCompletion = {
  readonly text?: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly modelUsed: string;
};

type LlmRouter = {
  readonly completeTurn: (params: {
    readonly provider: ModelProvider;
    readonly model?: string;
    readonly systemPrompt: string;
    readonly messages: readonly LlmTurnMessage[];
    readonly tools: readonly McpToolDescriptor[];
  }) => Promise<LlmCompletion>;
};

const DEFAULT_MODELS: Readonly<Record<ModelProvider, string>> = Object.freeze({
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  mock: "opsdeck-mock-triage-v1",
} as const);

const AnthropicResponseSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    ]),
  ),
});

const OpenAiResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            }),
          )
          .optional(),
      }),
    }),
  ),
});

const GeminiResponseSchema = z.object({
  candidates: z.array(
    z.object({
      content: z.object({
        parts: z.array(
          z.union([
            z.object({ text: z.string() }),
            z.object({
              functionCall: z.object({
                name: z.string(),
                args: z.record(z.string(), z.unknown()).optional(),
              }),
            }),
          ]),
        ),
      }),
    }),
  ),
});

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function normalizeSchemaValue(value: unknown, stripNullBranch: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map(function mapItem(item) {
      return normalizeSchemaValue(item, stripNullBranch);
    });
  }
  if (isPlainRecord(value) === false) {
    return value;
  }

  const out = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value);
  entries.forEach(function copyEntry(pair) {
    const key = pair[0];
    const entryVal = pair[1];
    if (key === "$schema" && stripNullBranch) {
      return;
    }
    if (key === "type" && Array.isArray(entryVal)) {
      const nonNullTypes = entryVal.filter(function keepNonNull(item): item is string {
        return typeof item === "string" && item !== "null";
      });
      if (stripNullBranch) {
        out.type = nonNullTypes[0] ?? "string";
        return;
      }
      out.anyOf = entryVal
        .filter(function isStr(item): item is string {
          return typeof item === "string";
        })
        .map(function toBranch(branchType) {
          return { type: branchType };
        });
      return;
    }
    out[key] = normalizeSchemaValue(entryVal, stripNullBranch);
  });
  return out;
}

function normalizeSchemaForSingleType(
  schema: Readonly<Record<string, unknown>>,
  stripNullBranch = false,
): Record<string, unknown> {
  const normalized = normalizeSchemaValue(schema, stripNullBranch);
  if (isPlainRecord(normalized)) {
    return { ...normalized };
  }
  return { type: "object", properties: {} };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val.trim().length === 0) {
    throw new Error(`Missing required API key environment variable '${name}'`);
  }
  return val.trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (isPlainRecord(parsed)) {
    return { ...parsed };
  }
  return {};
}

async function callAnthropic(params: {
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly LlmTurnMessage[];
  readonly tools: readonly McpToolDescriptor[];
}): Promise<LlmCompletion> {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const mappedMessages = params.messages.map(function mapMsg(msg): Record<string, unknown> {
    if (msg.role === "assistant_tool_calls") {
      return {
        role: "assistant",
        content: msg.calls.map(function mapCall(call) {
          return {
            type: "tool_use",
            id: call.id,
            name: call.qualifiedName,
            input: call.arguments,
          };
        }),
      };
    }
    if (msg.role === "tool_result") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: msg.content,
            is_error: msg.isError,
          },
        ],
      };
    }
    return { role: msg.role === "system" ? "user" : msg.role, content: msg.content };
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: 2048,
      system: params.systemPrompt,
      messages: mappedMessages,
      tools: params.tools.map(function mapTool(tool) {
        return {
          name: tool.qualifiedName,
          description: tool.description,
          input_schema: normalizeSchemaForSingleType(tool.inputSchema, false),
        };
      }),
    }),
  });

  if (response.ok === false) {
    throw new Error(`Anthropic API error (${response.status}): ${await response.text()}`);
  }

  const parsed = AnthropicResponseSchema.parse(await response.json());
  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  parsed.content.forEach(function collectBlock(block) {
    if (block.type === "text") {
      textParts.push(block.text);
      return;
    }
    toolCalls.push({
      id: block.id,
      qualifiedName: block.name,
      arguments: block.input,
    });
  });

  return {
    text: textParts.length > 0 ? textParts.join("\n") : undefined,
    toolCalls,
    modelUsed: params.model,
  };
}

async function callOpenAi(params: {
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly LlmTurnMessage[];
  readonly tools: readonly McpToolDescriptor[];
}): Promise<LlmCompletion> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const mappedMessages: Record<string, unknown>[] = [
    { role: "system", content: params.systemPrompt },
  ];

  params.messages.forEach(function pushMsg(msg) {
    if (msg.role === "assistant_tool_calls") {
      mappedMessages.push({
        role: "assistant",
        tool_calls: msg.calls.map(function mapCall(call) {
          return {
            id: call.id,
            type: "function",
            function: {
              name: call.qualifiedName,
              arguments: JSON.stringify(call.arguments),
            },
          };
        }),
      });
      return;
    }
    if (msg.role === "tool_result") {
      mappedMessages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
      return;
    }
    mappedMessages.push({ role: msg.role, content: msg.content });
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: mappedMessages,
      tools: params.tools.map(function mapTool(tool) {
        return {
          type: "function",
          function: {
            name: tool.qualifiedName,
            description: tool.description,
            parameters: normalizeSchemaForSingleType(tool.inputSchema, false),
          },
        };
      }),
    }),
  });

  if (response.ok === false) {
    throw new Error(`OpenAI API error (${response.status}): ${await response.text()}`);
  }

  const parsed = OpenAiResponseSchema.parse(await response.json());
  const message = parsed.choices[0]?.message;
  const toolCalls: LlmToolCall[] = (message?.tool_calls ?? []).map(function mapCall(call) {
    return {
      id: call.id,
      qualifiedName: call.function.name,
      arguments: parseJsonObject(call.function.arguments),
    };
  });

  return {
    text: message?.content ?? undefined,
    toolCalls,
    modelUsed: params.model,
  };
}

async function callGemini(params: {
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly LlmTurnMessage[];
  readonly tools: readonly McpToolDescriptor[];
}): Promise<LlmCompletion> {
  const apiKey = requireEnv("GEMINI_API_KEY");
  const contents = params.messages.map(function mapMsg(msg): Record<string, unknown> {
    if (msg.role === "assistant_tool_calls") {
      return {
        role: "model",
        parts: msg.calls.map(function mapCall(call) {
          return {
            functionCall: {
              name: call.qualifiedName,
              args: call.arguments,
            },
          };
        }),
      };
    }
    if (msg.role === "tool_result") {
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.qualifiedName,
              response: { result: msg.content, isError: msg.isError },
            },
          },
        ],
      };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: params.systemPrompt }] },
      contents,
      tools: [
        {
          functionDeclarations: params.tools.map(function mapTool(tool) {
            return {
              name: tool.qualifiedName,
              description: tool.description,
              parameters: normalizeSchemaForSingleType(tool.inputSchema, true),
            };
          }),
        },
      ],
    }),
  });

  if (response.ok === false) {
    throw new Error(`Gemini API error (${response.status}): ${await response.text()}`);
  }

  const parsed = GeminiResponseSchema.parse(await response.json());
  const parts = parsed.candidates[0]?.content.parts ?? [];
  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  parts.forEach(function collectPart(part, index) {
    if ("text" in part) {
      textParts.push(part.text);
      return;
    }
    toolCalls.push({
      id: `gemini-call-${index}`,
      qualifiedName: part.functionCall.name,
      arguments: part.functionCall.args ?? {},
    });
  });

  return {
    text: textParts.length > 0 ? textParts.join("\n") : undefined,
    toolCalls,
    modelUsed: params.model,
  };
}

function findPreferredTool(
  tools: readonly McpToolDescriptor[],
  shortName: string,
): McpToolDescriptor | undefined {
  return tools.find(function matchName(tool) {
    return tool.name === shortName;
  });
}

function isUserTextMessage(msg: LlmTurnMessage): msg is TextTurnMessage {
  return msg.role === "user";
}

async function callMock(params: {
  readonly model: string;
  readonly messages: readonly LlmTurnMessage[];
  readonly tools: readonly McpToolDescriptor[];
}): Promise<LlmCompletion> {
  const toolResults = params.messages.filter(function isToolResult(
    msg,
  ): msg is Extract<LlmTurnMessage, { readonly role: "tool_result" }> {
    return msg.role === "tool_result";
  });

  const lastUserMsg = [...params.messages].reverse().find(isUserTextMessage);
  const userText = (lastUserMsg?.content ?? "").toLowerCase();

  if (toolResults.length === 0 && userText.includes("rollback")) {
    const rollbackTool = findPreferredTool(params.tools, "rollback_deployment");
    if (rollbackTool !== undefined) {
      return {
        modelUsed: params.model,
        toolCalls: [
          {
            id: "mock-rollback-1",
            qualifiedName: rollbackTool.qualifiedName,
            arguments: {
              service_name: "checkout-api",
              target_version: "v2.14.2",
              actor: "alice@opsdeck.dev",
              reason: "SEV1 Postgres pool saturation after v2.14.3",
            },
          },
        ],
      };
    }
  }

  if (
    toolResults.length === 0 &&
    (userText.includes("probe") || userText.includes("diagnostic"))
  ) {
    const probeTool = findPreferredTool(params.tools, "run_diagnostic_probe");
    if (probeTool !== undefined) {
      return {
        modelUsed: params.model,
        toolCalls: [
          {
            id: "mock-probe-1",
            qualifiedName: probeTool.qualifiedName,
            arguments: {
              service_name: userText.includes("search") ? "search-indexer" : "checkout-api",
              stage_delay_ms: 600,
            },
          },
        ],
      };
    }
  }

  if (toolResults.length === 0) {
    const listIncidents = findPreferredTool(params.tools, "list_incidents");
    if (listIncidents !== undefined) {
      return {
        modelUsed: params.model,
        toolCalls: [
          {
            id: "mock-call-1",
            qualifiedName: listIncidents.qualifiedName,
            arguments: { status: "open" },
          },
        ],
      };
    }
  }

  if (
    toolResults.length === 1 &&
    userText.includes("rollback") === false &&
    userText.includes("probe") === false &&
    userText.includes("diagnostic") === false
  ) {
    const serviceDetail = findPreferredTool(params.tools, "get_service_detail");
    if (serviceDetail !== undefined) {
      const targetService = userText.includes("search") ? "search-indexer" : "checkout-api";
      return {
        modelUsed: params.model,
        toolCalls: [
          {
            id: "mock-call-2",
            qualifiedName: serviceDetail.qualifiedName,
            arguments: { service_name: targetService },
          },
        ],
      };
    }
  }

  const evidenceSummary = toolResults
    .map(function formatEvidence(item) {
      const preview = item.content.length > 420 ? `${item.content.slice(0, 420)}...` : item.content;
      return `- **${item.qualifiedName}** (${item.isError ? "error" : "ok"}):\n\`\`\`json\n${preview}\n\`\`\``;
    })
    .join("\n\n");

  const finalText = [
    `[OpsDeck Mock Router: ${params.model}] Grounded MCP investigation complete.`,
    evidenceSummary.length > 0
      ? `Tool evidence collected across ${toolResults.length} MCP round-trips:\n\n${evidenceSummary}`
      : "No MCP tools were available to invoke.",
    "Next recommended action: review active deployments and confirm rollback target `v2.14.2` if `checkout-api` latency remains elevated.",
  ].join("\n\n");

  return {
    modelUsed: params.model,
    text: finalText,
    toolCalls: [],
  };
}

type ProviderHandler = (params: {
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly LlmTurnMessage[];
  readonly tools: readonly McpToolDescriptor[];
}) => Promise<LlmCompletion>;

const PROVIDER_HANDLERS: Readonly<Record<ModelProvider, ProviderHandler>> = Object.freeze({
  anthropic: callAnthropic,
  openai: callOpenAi,
  gemini: callGemini,
  mock: callMock,
} as const);

function createLlmRouter(): LlmRouter {
  async function completeTurn(params: {
    readonly provider: ModelProvider;
    readonly model?: string;
    readonly systemPrompt: string;
    readonly messages: readonly LlmTurnMessage[];
    readonly tools: readonly McpToolDescriptor[];
  }): Promise<LlmCompletion> {
    const resolvedModel = params.model ?? DEFAULT_MODELS[params.provider];
    const handler = PROVIDER_HANDLERS[params.provider];
    return handler({
      model: resolvedModel,
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: params.tools,
    });
  }

  return Object.freeze({ completeTurn });
}

export { createLlmRouter, normalizeSchemaForSingleType };
export type { LlmCompletion, LlmRouter, LlmToolCall, LlmTurnMessage };
