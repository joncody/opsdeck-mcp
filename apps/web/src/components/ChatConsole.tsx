import type {
  ActivePromptRef,
  AttachedResourceRef,
  HostSseEvent,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpServerSnapshot,
  ModelProvider,
  TaskLifecycleStatus,
} from "@opsdeck/shared/protocol";
import {
  AtSign,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  KeyRound,
  Loader2,
  Send,
  ShieldAlert,
  Slash,
  Square,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useRef, useState } from "react";
import { cancelMcpTask, resumeElicitation, streamChatTurn } from "../api/hostClient";

type ToolExecutionCard = {
  readonly id: string;
  readonly step: number;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly status: "running" | "ok" | "error";
  readonly durationMs?: number;
  readonly contentText?: string;
};

type TaskExecutionCard = {
  readonly taskId: string;
  readonly serverId: string;
  readonly status: TaskLifecycleStatus;
  readonly statusMessage?: string;
};

type ElicitationCardState = {
  readonly elicitationId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly requestState?: string;
  readonly resolution?: "accept" | "decline" | "cancel";
};

type TimelineMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly traceId?: string;
  readonly toolCards: readonly ToolExecutionCard[];
  readonly taskCards: readonly TaskExecutionCard[];
  readonly elicitations: readonly ElicitationCardState[];
  readonly isStreaming: boolean;
};

type ChatConsoleProps = {
  readonly servers: readonly McpServerSnapshot[];
  readonly externalDraft?: string;
  readonly onClearExternalDraft: () => void;
  readonly onTelemetryEvent: (event: HostSseEvent) => void;
  readonly onTurnComplete: () => void;
};

type SchemaPropertySpec = {
  readonly key: string;
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly enumValues?: readonly string[];
  readonly defaultValue?: string | number | boolean;
  readonly required: boolean;
};

const PROVIDERS: readonly { readonly id: ModelProvider; readonly label: string }[] = [
  { id: "mock", label: "Mock SRE (No API Key)" },
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI (GPT)" },
  { id: "gemini", label: "Google (Gemini)" },
];

function nextId(): string {
  return crypto.randomUUID();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function fillTemplateExample(template: string): string {
  return template
    .replace("{name}", "checkout-api")
    .replace("{id}", "33333333-3333-4333-8333-333333333301")
    .replace("{slug}", "rollback-procedure");
}

function extractSchemaFields(
  schema: Readonly<Record<string, unknown>>,
): readonly SchemaPropertySpec[] {
  const propertiesRaw = isPlainRecord(schema.properties) ? schema.properties : {};
  const requiredSet = Array.isArray(schema.required)
    ? schema.required.filter(function isStr(item): item is string {
        return typeof item === "string";
      })
    : [];

  return Object.entries(propertiesRaw).map(function mapField(pair): SchemaPropertySpec {
    const key = pair[0];
    const spec = isPlainRecord(pair[1]) ? pair[1] : {};
    const type = typeof spec.type === "string" ? spec.type : "string";
    const title = typeof spec.title === "string" ? spec.title : key;
    const description = typeof spec.description === "string" ? spec.description : undefined;
    const enumValues = Array.isArray(spec.enum)
      ? spec.enum.filter(function isStr(v): v is string {
          return typeof v === "string";
        })
      : undefined;

    let defaultValue: string | number | boolean | undefined;
    if (
      typeof spec.default === "string" ||
      typeof spec.default === "number" ||
      typeof spec.default === "boolean"
    ) {
      defaultValue = spec.default;
    }

    return {
      key,
      type,
      title,
      description,
      enumValues,
      defaultValue,
      required: requiredSet.includes(key),
    };
  });
}

function buildInitialFormValues(
  fields: readonly SchemaPropertySpec[],
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  fields.forEach(function seedField(field) {
    if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
      return;
    }
    if (field.type === "boolean") {
      values[field.key] = false;
      return;
    }
    if (field.enumValues !== undefined && field.enumValues[0] !== undefined) {
      values[field.key] = field.enumValues[0];
      return;
    }
    values[field.key] = "";
  });
  return values;
}

type DynamicElicitationFormProps = {
  readonly card: ElicitationCardState;
  readonly onResolve: (
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
};

function DynamicElicitationForm(props: DynamicElicitationFormProps) {
  const fields = extractSchemaFields(props.card.requestedSchema);
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean>>(
    function initValues() {
      return buildInitialFormValues(fields);
    },
  );
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  async function submitDecision(action: "accept" | "decline" | "cancel"): Promise<void> {
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      await props.onResolve(
        props.card.elicitationId,
        action,
        action === "accept" ? formValues : undefined,
      );
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const resolved = props.card.resolution !== undefined;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-3.5 text-xs">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-amber-300">
          <ShieldAlert className="h-4 w-4" />
          Human Confirmation Required ({props.card.toolName})
        </div>
        {props.card.requestState !== undefined ? (
          <span
            title={props.card.requestState}
            className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-amber-200"
          >
            <KeyRound className="h-3 w-3" />
            requestState: {props.card.requestState.slice(0, 18)}...
          </span>
        ) : undefined}
      </div>

      <p className="mb-3 leading-relaxed text-slate-200">{props.card.message}</p>

      {resolved ? (
        <div className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono text-[11px] text-slate-300">
          Decision submitted: <strong className="text-cyan-300">{props.card.resolution}</strong>
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map(function renderField(field) {
            const currentVal = formValues[field.key];

            if (field.type === "boolean") {
              const checked = currentVal === true;
              return (
                <label
                  key={field.key}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-900/70 p-2.5"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={function onToggle(e) {
                      const nextChecked = e.target.checked;
                      setFormValues(function update(prev) {
                        return { ...prev, [field.key]: nextChecked };
                      });
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-950 text-cyan-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      {field.title}
                      {field.required ? " *" : ""}
                    </div>
                    {field.description !== undefined ? (
                      <div className="text-[11px] text-slate-400">{field.description}</div>
                    ) : undefined}
                  </div>
                </label>
              );
            }

            if (field.enumValues !== undefined && field.enumValues.length > 0) {
              return (
                <label key={field.key} className="block space-y-1">
                  <span className="font-medium text-slate-200">
                    {field.title}
                    {field.required ? " *" : ""}
                  </span>
                  <select
                    value={typeof currentVal === "string" ? currentVal : ""}
                    onChange={function onSelect(e) {
                      const nextStr = e.target.value;
                      setFormValues(function update(prev) {
                        return { ...prev, [field.key]: nextStr };
                      });
                    }}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                  >
                    {field.enumValues.map(function renderOpt(opt) {
                      return (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      );
                    })}
                  </select>
                </label>
              );
            }

            const inputType =
              field.type === "number" || field.type === "integer" ? "number" : "text";
            return (
              <label key={field.key} className="block space-y-1">
                <span className="font-medium text-slate-200">
                  {field.title}
                  {field.required ? " *" : ""}
                </span>
                {field.description !== undefined ? (
                  <span className="block text-[11px] text-slate-400">{field.description}</span>
                ) : undefined}
                <input
                  type={inputType}
                  value={currentVal !== undefined ? String(currentVal) : ""}
                  onChange={function onText(e) {
                    const raw = e.target.value;
                    const parsedVal =
                      inputType === "number" && raw.length > 0 ? Number(raw) : raw;
                    setFormValues(function update(prev) {
                      return { ...prev, [field.key]: parsedVal };
                    });
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                />
              </label>
            );
          })}

          {submitError !== undefined ? (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-rose-300">
              {submitError}
            </div>
          ) : undefined}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={function onCancelClick() {
                void submitDecision("cancel");
              }}
              className="cursor-pointer rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={function onDeclineClick() {
                void submitDecision("decline");
              }}
              className="cursor-pointer rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Decline
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={function onAcceptClick() {
                void submitDecision("accept");
              }}
              className="cursor-pointer rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve &amp; Resume
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatConsole(props: ChatConsoleProps) {
  const [provider, setProvider] = useState<ModelProvider>("mock");
  const [modelOverride, setModelOverride] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<readonly TimelineMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [attachedResources, setAttachedResources] = useState<readonly AttachedResourceRef[]>([]);
  const [activePrompt, setActivePrompt] = useState<ActivePromptRef | undefined>(undefined);

  const [pickerMode, setPickerMode] = useState<"none" | "prompt" | "resource">("none");
  const [selectedPromptDraft, setSelectedPromptDraft] = useState<McpPromptDescriptor | undefined>(
    undefined,
  );
  const [promptArgValues, setPromptArgValues] = useState<Readonly<Record<string, string>>>({});
  const [templateUriDraft, setTemplateUriDraft] = useState<string>("");
  const [expandedCards, setExpandedCards] = useState<Readonly<Record<string, boolean>>>({});

  const abortRef = useRef<AbortController | undefined>(undefined);

  const effectiveInput =
    props.externalDraft !== undefined && props.externalDraft.length > 0 && input.length === 0
      ? props.externalDraft
      : input;

  const allPrompts = props.servers.flatMap(function collectPrompts(server) {
    return server.prompts;
  });
  const allResources = props.servers.flatMap(function collectResources(server) {
    return server.resources;
  });
  const allTemplates = props.servers.flatMap(function collectTemplates(server) {
    return server.resourceTemplates;
  });

  function toggleCardExpanded(cardId: string): void {
    setExpandedCards(function flip(prev) {
      const next = Object.create(null) as Record<string, boolean>;
      Object.entries(prev).forEach(function copy(entry) {
        next[entry[0]] = entry[1];
      });
      next[cardId] = prev[cardId] !== true;
      return next;
    });
  }

  function handleInputChange(nextText: string): void {
    if (props.externalDraft !== undefined && props.externalDraft.length > 0) {
      props.onClearExternalDraft();
    }
    setInput(nextText);
    if (nextText === "/") {
      setPickerMode("prompt");
      return;
    }
    if (nextText.endsWith("@")) {
      setPickerMode("resource");
    }
  }

  function attachResource(serverId: string, uri: string): void {
    setAttachedResources(function addUnique(prev) {
      const exists = prev.some(function match(item) {
        return item.serverId === serverId && item.uri === uri;
      });
      if (exists) {
        return prev;
      }
      return [...prev, { serverId, uri }];
    });
    if (input.endsWith("@")) {
      setInput(input.slice(0, -1));
    }
    setPickerMode("none");
    setTemplateUriDraft("");
  }

  function removeAttachedResource(uri: string): void {
    setAttachedResources(function filterOut(prev) {
      return prev.filter(function keep(item) {
        return item.uri !== uri;
      });
    });
  }

  function confirmPromptSelection(prompt: McpPromptDescriptor): void {
    const cleanedArgs = Object.create(null) as Record<string, string>;
    prompt.arguments.forEach(function copyArg(arg) {
      const raw = promptArgValues[arg.name];
      if (raw !== undefined && raw.trim().length > 0) {
        cleanedArgs[arg.name] = raw.trim();
      }
    });
    setActivePrompt({
      serverId: prompt.serverId,
      name: prompt.name,
      arguments: Object.keys(cleanedArgs).length > 0 ? cleanedArgs : undefined,
    });
    if (input === "/") {
      setInput("");
    }
    setSelectedPromptDraft(undefined);
    setPromptArgValues({});
    setPickerMode("none");
  }

  function applyPromptChoice(prompt: McpPromptDescriptor): void {
    if (prompt.arguments.length === 0) {
      confirmPromptSelection(prompt);
      return;
    }
    const defaults = Object.create(null) as Record<string, string>;
    prompt.arguments.forEach(function seedArg(arg) {
      if (arg.name === "incident_id") {
        defaults[arg.name] = "33333333-3333-4333-8333-333333333301";
      } else if (arg.name === "service_name") {
        defaults[arg.name] = "checkout-api";
      }
    });
    setPromptArgValues(defaults);
    setSelectedPromptDraft(prompt);
  }

  function updateAssistantTurn(
    assistantId: string,
    updater: (msg: TimelineMessage) => TimelineMessage,
  ): void {
    setMessages(function mapList(prev) {
      return prev.map(function mapItem(item) {
        if (item.id !== assistantId) {
          return item;
        }
        return updater(item);
      });
    });
  }

  async function handleResolveElicitation(
    assistantId: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await resumeElicitation({ elicitationId, action, content });
    updateAssistantTurn(assistantId, function markResolved(msg) {
      return {
        ...msg,
        elicitations: msg.elicitations.map(function updateItem(item) {
          if (item.elicitationId !== elicitationId) {
            return item;
          }
          return { ...item, resolution: action };
        }),
      };
    });
  }

  async function handleCancelTask(serverId: string, taskId: string): Promise<void> {
    await cancelMcpTask(serverId, taskId);
  }

  function handleStop(): void {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setIsStreaming(false);
  }

  function handleClearChat(): void {
    if (isStreaming) {
      handleStop();
    }
    setMessages([]);
    setExpandedCards({});
  }

  async function submitMessage(overridePromptText?: string): Promise<void> {
    const rawText = overridePromptText ?? effectiveInput;
    const trimmed = rawText.trim();
    if (trimmed.length === 0 || isStreaming) {
      return;
    }

    props.onClearExternalDraft();
    setInput("");
    setPickerMode("none");

    const userMsg: TimelineMessage = {
      id: nextId(),
      role: "user",
      content: trimmed,
      toolCards: [],
      taskCards: [],
      elicitations: [],
      isStreaming: false,
    };
    const assistantId = nextId();
    const assistantPlaceholder: TimelineMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      toolCards: [],
      taskCards: [],
      elicitations: [],
      isStreaming: true,
    };

    const historyForRequest = [...messages, userMsg].map(function toApiMsg(msg) {
      return { role: msg.role, content: msg.content };
    });

    setMessages(function appendTurns(prev) {
      return [...prev, userMsg, assistantPlaceholder];
    });
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const currentAttachments = [...attachedResources];
    const currentPrompt = activePrompt;
    setAttachedResources([]);
    setActivePrompt(undefined);

    try {
      await streamChatTurn({
        request: {
          provider,
          model: modelOverride.trim().length > 0 ? modelOverride.trim() : undefined,
          messages: historyForRequest,
          attachedResources: currentAttachments,
          activePrompt: currentPrompt,
          maxSteps: 6,
        },
        signal: controller.signal,
        onEvent: function handleEvent(event) {
          props.onTelemetryEvent(event);

          if (event.kind === "token") {
            updateAssistantTurn(assistantId, function appendToken(msg) {
              return {
                ...msg,
                traceId: event.traceId,
                content: msg.content + event.text,
              };
            });
            return;
          }

          if (event.kind === "tool_call") {
            const cardId = `${event.traceId}-${event.step}-${event.toolName}`;
            updateAssistantTurn(assistantId, function addToolCall(msg) {
              return {
                ...msg,
                traceId: event.traceId,
                toolCards: [
                  ...msg.toolCards,
                  {
                    id: cardId,
                    step: event.step,
                    serverId: event.serverId,
                    toolName: event.toolName,
                    arguments: event.arguments,
                    status: "running",
                  },
                ],
              };
            });
            return;
          }

          if (event.kind === "tool_result") {
            updateAssistantTurn(assistantId, function finishToolCall(msg) {
              const updatedCards = msg.toolCards.map(function updateCard(card) {
                if (card.step === event.step && card.toolName === event.toolName) {
                  return {
                    ...card,
                    status: event.isError ? ("error" as const) : ("ok" as const),
                    durationMs: event.durationMs,
                    contentText: event.contentText,
                  };
                }
                return card;
              });
              return { ...msg, toolCards: updatedCards };
            });
            return;
          }

          if (event.kind === "elicitation_required") {
            updateAssistantTurn(assistantId, function addElicitation(msg) {
              return {
                ...msg,
                traceId: event.traceId,
                elicitations: [
                  ...msg.elicitations,
                  {
                    elicitationId: event.elicitationId,
                    serverId: event.serverId,
                    toolName: event.toolName,
                    message: event.message,
                    requestedSchema: event.requestedSchema,
                    requestState: event.requestState,
                  },
                ],
              };
            });
            return;
          }

          if (event.kind === "task_update") {
            updateAssistantTurn(assistantId, function upsertTask(msg) {
              const exists = msg.taskCards.some(function matchTask(t) {
                return t.taskId === event.taskId;
              });
              const nextTask: TaskExecutionCard = {
                taskId: event.taskId,
                serverId: event.serverId,
                status: event.status,
                statusMessage: event.statusMessage,
              };
              const nextTasks = exists
                ? msg.taskCards.map(function replaceTask(t) {
                    return t.taskId === event.taskId ? nextTask : t;
                  })
                : [...msg.taskCards, nextTask];
              return { ...msg, traceId: event.traceId, taskCards: nextTasks };
            });
            return;
          }

          if (event.kind === "done") {
            updateAssistantTurn(assistantId, function finishTurn(msg) {
              return {
                ...msg,
                traceId: event.traceId,
                content: msg.content.length > 0 ? msg.content : event.finalText,
                isStreaming: false,
              };
            });
            props.onTurnComplete();
            return;
          }

          if (event.kind === "error") {
            updateAssistantTurn(assistantId, function failTurn(msg) {
              return {
                ...msg,
                traceId: event.traceId,
                content: `Error: ${event.message}`,
                isStreaming: false,
              };
            });
          }
        },
      });
    } catch (err) {
      if (controller.signal.aborted === false) {
        const message = err instanceof Error ? err.message : String(err);
        updateAssistantTurn(assistantId, function setFetchError(msg) {
          return { ...msg, content: `Request failed: ${message}`, isStreaming: false };
        });
      }
    } finally {
      updateAssistantTurn(assistantId, function stopSpinner(msg) {
        return { ...msg, isStreaming: false };
      });
      setIsStreaming(false);
      abortRef.current = undefined;
    }
  }

  return (
    <section className="flex h-full flex-col bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-cyan-400" />
          <span className="text-xs font-semibold tracking-wider text-slate-300 uppercase">
            Agent Console
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Model provider"
            value={provider}
            onChange={function handleProvider(e) {
              setProvider(e.target.value as ModelProvider);
            }}
            className="cursor-pointer rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none"
          >
            {PROVIDERS.map(function renderProvider(item) {
              return (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              );
            })}
          </select>

          <input
            type="text"
            value={modelOverride}
            onChange={function handleModel(e) {
              setModelOverride(e.target.value);
            }}
            placeholder="Model override (optional)"
            className="w-36 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />

          <button
            type="button"
            disabled={isStreaming}
            onClick={function runQuickTriage() {
              void submitMessage("Triage checkout-api SEV1 outage and check recent deployments");
            }}
            className="cursor-pointer rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Triage
          </button>

          <button
            type="button"
            disabled={isStreaming}
            onClick={function runQuickProbe() {
              void submitMessage("Run diagnostic probe on checkout-api");
            }}
            className="cursor-pointer rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Probe (Task)
          </button>

          <button
            type="button"
            disabled={isStreaming}
            onClick={function runQuickRollback() {
              void submitMessage("Rollback checkout-api to v2.14.2");
            }}
            className="cursor-pointer rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Rollback (Elicit)
          </button>

          <button
            type="button"
            disabled={messages.length === 0}
            onClick={handleClearChat}
            title="Clear chat history"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-rose-500 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-300">
            <div className="mb-2 flex items-center gap-2 font-semibold text-slate-100">
              <Bot className="h-4 w-4 text-cyan-400" />
              OpsDeck MCP Copilot Ready (2026-07-28 Stateless HTTP)
            </div>
            <p className="text-xs leading-relaxed text-slate-400">
              Use <code className="rounded bg-slate-800 px-1 py-0.5 text-cyan-300">/</code> for
              MCP Prompts,{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-emerald-300">@</code> for MCP
              Resources, <strong>Probe (Task)</strong> to test cooperative{" "}
              <code>io.modelcontextprotocol/tasks</code>, or <strong>Rollback (Elicit)</strong> to
              trigger <code>InputRequiredResult</code> human confirmation.
            </p>
          </div>
        ) : undefined}

        {messages.map(function renderMessage(msg) {
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              className={
                isUser
                  ? "ml-auto max-w-2xl rounded-xl border border-cyan-500/30 bg-cyan-950/30 px-4 py-3 text-sm text-slate-100"
                  : "mr-auto max-w-3xl space-y-2.5 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm text-slate-200"
              }
            >
              <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
                <span>{isUser ? "Operator" : "OpsDeck Copilot"}</span>
                {msg.traceId !== undefined ? (
                  <span className="font-mono text-[10px] text-slate-500">
                    trace:{msg.traceId.slice(0, 8)}
                  </span>
                ) : undefined}
              </div>

              {msg.toolCards.length > 0 ? (
                <div className="space-y-1.5">
                  {msg.toolCards.map(function renderToolCard(card) {
                    const isOpen = expandedCards[card.id] === true;
                    const badgeClass =
                      card.status === "running"
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                        : card.status === "error"
                          ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";

                    return (
                      <div
                        key={card.id}
                        className="rounded-lg border border-slate-800 bg-slate-950/80 text-xs"
                      >
                        <button
                          type="button"
                          onClick={function toggle() {
                            toggleCardExpanded(card.id);
                          }}
                          className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left hover:bg-slate-900/60"
                        >
                          <span className="flex items-center gap-2 font-mono text-slate-200">
                            {isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                            )}
                            <Terminal className="h-3.5 w-3.5 text-cyan-400" />
                            {card.toolName}
                          </span>
                          <span className="flex items-center gap-2">
                            {card.durationMs !== undefined ? (
                              <span className="font-mono text-[11px] text-slate-400">
                                {card.durationMs}ms
                              </span>
                            ) : undefined}
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${badgeClass}`}
                            >
                              {card.status}
                            </span>
                          </span>
                        </button>

                        {isOpen ? (
                          <div className="space-y-2 border-t border-slate-800 p-3 font-mono text-[11px]">
                            <div>
                              <div className="mb-1 text-slate-400">Arguments</div>
                              <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-slate-300">
                                {JSON.stringify(card.arguments, undefined, 2)}
                              </pre>
                            </div>
                            {card.contentText !== undefined ? (
                              <div>
                                <div className="mb-1 text-slate-400">Result</div>
                                <pre className="max-h-48 overflow-auto rounded bg-slate-900 p-2 text-slate-300">
                                  {card.contentText}
                                </pre>
                              </div>
                            ) : undefined}
                          </div>
                        ) : undefined}
                      </div>
                    );
                  })}
                </div>
              ) : undefined}

              {msg.taskCards.length > 0 ? (
                <div className="space-y-1.5">
                  {msg.taskCards.map(function renderTaskCard(task) {
                    const isWorking = task.status === "working" || task.status === "input_required";
                    const isCancelled = task.status === "cancelled" || task.status === "failed";
                    return (
                      <div
                        key={task.taskId}
                        className="flex items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-950/20 px-3 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          {isWorking ? (
                            <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                          ) : isCancelled ? (
                            <XCircle className="h-4 w-4 text-rose-400" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          )}
                          <div>
                            <div className="font-mono text-[11px] text-slate-200">
                              task:{task.taskId.slice(0, 12)} ·{" "}
                              <span className="uppercase text-sky-300">{task.status}</span>
                            </div>
                            {task.statusMessage !== undefined ? (
                              <div className="text-[11px] text-slate-400">{task.statusMessage}</div>
                            ) : undefined}
                          </div>
                        </div>

                        {isWorking ? (
                          <button
                            type="button"
                            onClick={function cancelClick() {
                              void handleCancelTask(task.serverId, task.taskId);
                            }}
                            className="cursor-pointer rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20"
                          >
                            Cancel Task
                          </button>
                        ) : undefined}
                      </div>
                    );
                  })}
                </div>
              ) : undefined}

              {msg.elicitations.length > 0 ? (
                <div className="space-y-2">
                  {msg.elicitations.map(function renderElicit(card) {
                    return (
                      <DynamicElicitationForm
                        key={card.elicitationId}
                        card={card}
                        onResolve={async function resolveDecision(elicitationId, action, content) {
                          await handleResolveElicitation(msg.id, elicitationId, action, content);
                        }}
                      />
                    );
                  })}
                </div>
              ) : undefined}

              <div className="whitespace-pre-wrap leading-relaxed">
                {msg.content}
                {msg.isStreaming ? (
                  <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-cyan-400 align-middle" />
                ) : undefined}
              </div>
            </div>
          );
        })}
      </div>

      <div className="relative border-t border-slate-800 bg-slate-900/50 p-3">
        {pickerMode === "prompt" ? (
          <div className="mb-2 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-200">
              <span>MCP Prompts (/)</span>
              <button
                type="button"
                onClick={function closePicker() {
                  setPickerMode("none");
                  setSelectedPromptDraft(undefined);
                }}
                className="cursor-pointer text-slate-400 hover:text-slate-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {selectedPromptDraft === undefined ? (
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {allPrompts.map(function renderPrompt(prompt: McpPromptDescriptor) {
                  return (
                    <button
                      key={`${prompt.serverId}-${prompt.name}`}
                      type="button"
                      onClick={function choose() {
                        applyPromptChoice(prompt);
                      }}
                      className="flex w-full cursor-pointer items-start justify-between rounded-md px-2.5 py-2 text-left text-xs hover:bg-slate-800"
                    >
                      <div>
                        <div className="font-mono font-medium text-cyan-300">/{prompt.name}</div>
                        <div className="text-[11px] text-slate-400">{prompt.description}</div>
                      </div>
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {prompt.serverId}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2 text-xs">
                <div className="font-mono text-cyan-300">/{selectedPromptDraft.name}</div>
                {selectedPromptDraft.arguments.map(function renderArg(arg) {
                  return (
                    <label key={arg.name} className="block space-y-1">
                      <span className="text-[11px] text-slate-300">
                        {arg.name}
                        {arg.required === true ? " *" : ""} — {arg.description}
                      </span>
                      <input
                        type="text"
                        value={promptArgValues[arg.name] ?? ""}
                        onChange={function updateArg(e) {
                          const nextVal = e.target.value;
                          setPromptArgValues(function setField(prev) {
                            return { ...prev, [arg.name]: nextVal };
                          });
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                  );
                })}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={function backToList() {
                      setSelectedPromptDraft(undefined);
                    }}
                    className="cursor-pointer rounded border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={function attachPrompt() {
                      confirmPromptSelection(selectedPromptDraft);
                    }}
                    className="cursor-pointer rounded bg-cyan-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-500"
                  >
                    Attach Prompt
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : undefined}

        {pickerMode === "resource" ? (
          <div className="mb-2 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-200">
              <span>MCP Resources &amp; Templates (@)</span>
              <button
                type="button"
                onClick={function closeResPicker() {
                  setPickerMode("none");
                }}
                className="cursor-pointer text-slate-400 hover:text-slate-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="max-h-52 space-y-2 overflow-y-auto text-xs">
              {allResources.map(function renderRes(res: McpResourceDescriptor) {
                return (
                  <button
                    key={`${res.serverId}-${res.uri}`}
                    type="button"
                    onClick={function pickRes() {
                      attachResource(res.serverId, res.uri);
                    }}
                    className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left hover:bg-slate-800"
                  >
                    <div>
                      <div className="font-mono text-emerald-300">{res.uri}</div>
                      <div className="text-[11px] text-slate-400">{res.description}</div>
                    </div>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {res.serverId}
                    </span>
                  </button>
                );
              })}

              <div className="border-t border-slate-800 pt-2">
                <div className="mb-1 text-[11px] font-medium text-slate-400">URI Templates</div>
                <div className="flex flex-wrap gap-1.5">
                  {allTemplates.map(function renderTpl(tpl: McpResourceTemplateDescriptor) {
                    return (
                      <button
                        key={tpl.uriTemplate}
                        type="button"
                        onClick={function fillTpl() {
                          setTemplateUriDraft(fillTemplateExample(tpl.uriTemplate));
                        }}
                        className="cursor-pointer rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-cyan-300 hover:border-cyan-500"
                      >
                        {tpl.uriTemplate}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={templateUriDraft}
                    onChange={function handleTplInput(e) {
                      setTemplateUriDraft(e.target.value);
                    }}
                    placeholder="ops://services/checkout-api"
                    className="flex-1 rounded border border-slate-700 bg-slate-950 px-2.5 py-1 font-mono text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={templateUriDraft.trim().length === 0}
                    onClick={function attachCustomUri() {
                      attachResource("server-ops", templateUriDraft.trim());
                    }}
                    className="cursor-pointer rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Attach URI
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : undefined}

        {activePrompt !== undefined || attachedResources.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {activePrompt !== undefined ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[11px] text-cyan-300">
                /{activePrompt.name}
                <button
                  type="button"
                  onClick={function clearPrompt() {
                    setActivePrompt(undefined);
                  }}
                  className="cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : undefined}

            {attachedResources.map(function renderAttachment(item) {
              return (
                <span
                  key={item.uri}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] text-emerald-300"
                >
                  @{item.uri}
                  <button
                    type="button"
                    onClick={function removeRes() {
                      removeAttachedResource(item.uri);
                    }}
                    className="cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        ) : undefined}

        <form
          onSubmit={function handleSubmit(e) {
            e.preventDefault();
            void submitMessage();
          }}
          className="flex items-end gap-2"
        >
          <div className="flex gap-1">
            <button
              type="button"
              title="MCP Prompts (/)"
              onClick={function togglePromptPicker() {
                setPickerMode(pickerMode === "prompt" ? "none" : "prompt");
              }}
              className="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
            >
              <Slash className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="MCP Resources (@)"
              onClick={function toggleResourcePicker() {
                setPickerMode(pickerMode === "resource" ? "none" : "resource");
              }}
              className="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
            >
              <AtSign className="h-4 w-4" />
            </button>
          </div>

          <textarea
            rows={2}
            value={effectiveInput}
            onChange={function onTextChange(e) {
              handleInputChange(e.target.value);
            }}
            onKeyDown={function onKeyDown(e) {
              if (e.key === "Enter" && e.shiftKey === false) {
                e.preventDefault();
                void submitMessage();
              }
            }}
            placeholder="Ask OpsDeck Copilot... (/ for MCP Prompts, @ for MCP Resources)"
            className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />

          {isStreaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 text-xs font-semibold text-white hover:bg-rose-500"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={effectiveInput.trim().length === 0}
              className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-cyan-600 px-3.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          )}
        </form>
      </div>
    </section>
  );
}

export { ChatConsole };
