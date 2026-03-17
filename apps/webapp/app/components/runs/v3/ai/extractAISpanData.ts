import type { AISpanData, DisplayItem, ToolDefinition, ToolUse } from "./types";

/**
 * Extracts structured AI span data from unflattened OTEL span properties.
 *
 * Works with the nested object produced by `unflattenAttributes()` — expects
 * keys like `gen_ai.response.model`, `ai.prompt.messages`, `trigger.llm.total_cost`, etc.
 *
 * @param properties  Unflattened span properties object
 * @param durationMs  Span duration in milliseconds
 * @returns Structured AI data, or undefined if this isn't an AI generation span
 */
export function extractAISpanData(
  properties: Record<string, unknown>,
  durationMs: number
): AISpanData | undefined {
  const genAi = properties.gen_ai;
  if (!genAi || typeof genAi !== "object") return undefined;

  const g = genAi as Record<string, unknown>;
  const ai = rec(properties.ai);
  const trigger = rec(properties.trigger);

  const gResponse = rec(g.response);
  const gRequest = rec(g.request);
  const gUsage = rec(g.usage);
  const gOperation = rec(g.operation);
  const aiModel = rec(ai.model);
  const aiResponse = rec(ai.response);
  const aiPrompt = rec(ai.prompt);
  const aiUsage = rec(ai.usage);
  const triggerLlm = rec(trigger.llm);

  const model = str(gResponse.model) ?? str(gRequest.model) ?? str(aiModel.id);
  if (!model) return undefined;

  // Prefer ai.usage (richer) over gen_ai.usage.
  // Gateway/some providers emit promptTokens/completionTokens instead of inputTokens/outputTokens.
  const inputTokens =
    num(aiUsage.inputTokens) ?? num(aiUsage.promptTokens) ?? num(gUsage.input_tokens) ?? 0;
  const outputTokens =
    num(aiUsage.outputTokens) ?? num(aiUsage.completionTokens) ?? num(gUsage.output_tokens) ?? 0;
  const totalTokens = num(aiUsage.totalTokens) ?? inputTokens + outputTokens;

  const tokensPerSecond =
    num(aiResponse.avgOutputTokensPerSecond) ??
    (outputTokens > 0 && durationMs > 0
      ? Math.round((outputTokens / (durationMs / 1000)) * 10) / 10
      : undefined);

  const toolDefs = parseToolDefinitions(aiPrompt.tools);
  const providerMeta = parseProviderMetadata(aiResponse.providerMetadata);
  const aiTelemetry = rec(ai.telemetry);
  const telemetryMeta = extractTelemetryMetadata(aiTelemetry.metadata);

  return {
    model,
    provider: str(g.system) ?? "unknown",
    operationName: str(gOperation.name) ?? str(ai.operationId) ?? "",
    finishReason: str(aiResponse.finishReason),
    serviceTier: providerMeta?.serviceTier,
    resolvedProvider: providerMeta?.resolvedProvider,
    toolChoice: parseToolChoice(aiPrompt.toolChoice),
    toolCount: toolDefs?.length,
    messageCount: countMessages(aiPrompt.messages),
    telemetryMetadata: telemetryMeta,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: num(aiUsage.cachedInputTokens) ?? num(gUsage.cache_read_input_tokens),
    cacheCreationTokens:
      num(aiUsage.cacheCreationInputTokens) ?? num(gUsage.cache_creation_input_tokens),
    reasoningTokens: num(aiUsage.reasoningTokens) ?? num(gUsage.reasoning_tokens),
    tokensPerSecond,
    msToFirstChunk: num(aiResponse.msToFirstChunk),
    durationMs,
    inputCost: num(triggerLlm.input_cost),
    outputCost: num(triggerLlm.output_cost),
    totalCost: num(triggerLlm.total_cost),
    responseText: str(aiResponse.text) || undefined,
    responseObject: str(aiResponse.object) || undefined,
    toolDefinitions: toolDefs,
    items: buildDisplayItems(aiPrompt.messages, aiResponse.toolCalls, toolDefs),
  };
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Message → DisplayItem transformation
// ---------------------------------------------------------------------------

type RawMessage = {
  role: string;
  content: unknown;
  toolCallId?: string;
  name?: string;
};

/**
 * Build display items from prompt messages and optionally response tool calls.
 * - Parses ai.prompt.messages and merges consecutive tool-call + tool-result pairs
 * - If ai.response.toolCalls is present (finishReason=tool-calls), appends those too
 */
function buildDisplayItems(
  messagesRaw: unknown,
  responseToolCallsRaw: unknown,
  toolDefs?: ToolDefinition[]
): DisplayItem[] | undefined {
  const items = parseMessagesToDisplayItems(messagesRaw);
  const responseToolCalls = parseResponseToolCalls(responseToolCallsRaw);

  if (!items && !responseToolCalls) return undefined;

  const result = items ?? [];

  if (responseToolCalls && responseToolCalls.length > 0) {
    result.push({ type: "tool-use", tools: responseToolCalls });
  }

  if (toolDefs && toolDefs.length > 0) {
    const defsByName = new Map(toolDefs.map((d) => [d.name, d]));
    for (const item of result) {
      if (item.type === "tool-use") {
        for (const tool of item.tools) {
          const def = defsByName.get(tool.toolName);
          if (def) {
            tool.description = def.description;
            tool.parametersJson = def.parametersJson;
          }
        }
      }
    }
  }

  return result.length > 0 ? result : undefined;
}

function parseMessagesToDisplayItems(raw: unknown): DisplayItem[] | undefined {
  if (typeof raw !== "string") return undefined;

  let messages: RawMessage[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    messages = parsed.map((item: unknown) => {
      const m = rec(item);
      return {
        role: str(m.role) ?? "user",
        content: m.content,
        toolCallId: str(m.toolCallId),
        name: str(m.name),
      };
    });
  } catch {
    return undefined;
  }

  const items: DisplayItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "system") {
      items.push({ type: "system", text: extractTextContent(msg.content) });
      i++;
      continue;
    }

    if (msg.role === "user") {
      items.push({ type: "user", text: extractTextContent(msg.content) });
      i++;
      continue;
    }

    // Assistant message — check if it contains tool calls
    if (msg.role === "assistant") {
      const toolCalls = extractToolCalls(msg.content);

      if (toolCalls.length > 0) {
        // Collect subsequent tool result messages that match these tool calls
        const toolCallIds = new Set(toolCalls.map((tc) => tc.toolCallId));
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          j++;
        }
        // Gather tool result messages between i+1 and j
        const toolResultMsgs = messages.slice(i + 1, j);

        // Build ToolUse entries by pairing calls with results
        const tools: ToolUse[] = toolCalls.map((tc) => {
          const resultMsg = toolResultMsgs.find((m) => {
            // Match by toolCallId in the message's content parts
            const results = extractToolResults(m.content);
            return results.some((r) => r.toolCallId === tc.toolCallId);
          });

          const result = resultMsg
            ? extractToolResults(resultMsg.content).find(
              (r) => r.toolCallId === tc.toolCallId
            )
            : undefined;

          return {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            inputJson: JSON.stringify(tc.input, null, 2),
            resultSummary: result?.summary,
            resultOutput: result?.formattedOutput,
          };
        });

        items.push({ type: "tool-use", tools });
        i = j; // skip past the tool result messages
        continue;
      }

      // Assistant message with just text
      const text = extractTextContent(msg.content);
      if (text) {
        items.push({ type: "assistant", text });
      }
      i++;
      continue;
    }

    // Skip any other message types (tool messages that weren't consumed above)
    i++;
  }

  return items.length > 0 ? items : undefined;
}

// ---------------------------------------------------------------------------
// Response tool calls (from ai.response.toolCalls, used when finishReason=tool-calls)
// ---------------------------------------------------------------------------

/**
 * Parse ai.response.toolCalls JSON string into ToolUse entries.
 * These are tool calls the model requested but haven't been executed yet in this span.
 */
function parseResponseToolCalls(raw: unknown): ToolUse[] | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const tools: ToolUse[] = [];
    for (const item of parsed) {
      const tc = rec(item);
      if (tc.type === "tool-call" || tc.toolName || tc.toolCallId) {
        tools.push({
          toolCallId: str(tc.toolCallId) ?? "",
          toolName: str(tc.toolName) ?? "",
          inputJson: JSON.stringify(
            tc.input && typeof tc.input === "object" ? tc.input : {},
            null,
            2
          ),
        });
      }
    }
    return tools.length > 0 ? tools : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Content part extraction
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const raw of content) {
    const p = rec(raw);
    if (p.type === "text" && typeof p.text === "string") {
      texts.push(p.text);
    } else if (typeof p.text === "string") {
      texts.push(p.text);
    }
  }
  return texts.join("\n");
}

type ParsedToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

function extractToolCalls(content: unknown): ParsedToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: ParsedToolCall[] = [];
  for (const raw of content) {
    const p = rec(raw);
    if (p.type === "tool-call") {
      calls.push({
        toolCallId: str(p.toolCallId) ?? "",
        toolName: str(p.toolName) ?? "",
        input: p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {},
      });
    }
  }
  return calls;
}

type ParsedToolResult = {
  toolCallId: string;
  toolName: string;
  summary: string;
  formattedOutput: string;
};

function extractToolResults(content: unknown): ParsedToolResult[] {
  if (!Array.isArray(content)) return [];
  const results: ParsedToolResult[] = [];
  for (const raw of content) {
    const p = rec(raw);
    if (p.type === "tool-result") {
      const { summary, formattedOutput } = summarizeToolOutput(p.output);
      results.push({
        toolCallId: str(p.toolCallId) ?? "",
        toolName: str(p.toolName) ?? "",
        summary,
        formattedOutput,
      });
    }
  }
  return results;
}

/**
 * Summarize a tool output into a short label and a formatted string for display.
 * Handles the AI SDK's `{ type: "json", value: { status, contentType, body, truncated } }` shape.
 */
function summarizeToolOutput(output: unknown): { summary: string; formattedOutput: string } {
  if (typeof output === "string") {
    return {
      summary: output.length > 80 ? output.slice(0, 80) + "..." : output,
      formattedOutput: output,
    };
  }

  if (!output || typeof output !== "object") {
    return { summary: "result", formattedOutput: JSON.stringify(output, null, 2) };
  }

  const o = output as Record<string, unknown>;

  // AI SDK wraps tool results as { type: "json", value: { status, contentType, body, ... } }
  if (o.type === "json" && o.value && typeof o.value === "object") {
    const v = o.value as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof v.status === "number") parts.push(`${v.status}`);
    if (typeof v.contentType === "string") parts.push(v.contentType);
    if (v.truncated === true) parts.push("truncated");
    return {
      summary: parts.length > 0 ? parts.join(" · ") : "json result",
      formattedOutput: JSON.stringify(v, null, 2),
    };
  }

  return { summary: "result", formattedOutput: JSON.stringify(output, null, 2) };
}

// ---------------------------------------------------------------------------
// Tool definitions (from ai.prompt.tools)
// ---------------------------------------------------------------------------

/**
 * Parse ai.prompt.tools — after the array fix, this arrives as a JSON array string
 * where each element is itself a JSON string of a tool definition.
 */
function parseToolDefinitions(raw: unknown): ToolDefinition[] | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const defs: ToolDefinition[] = [];
    for (const item of parsed) {
      // Each item is either a JSON string or already an object
      const obj = typeof item === "string" ? JSON.parse(item) : item;
      if (!obj || typeof obj !== "object") continue;
      const o = obj as Record<string, unknown>;
      const name = str(o.name);
      if (!name) continue;
      const schema = o.parameters ?? o.inputSchema;
      defs.push({
        name,
        description: str(o.description),
        parametersJson:
          schema && typeof schema === "object"
            ? JSON.stringify(schema, null, 2)
            : undefined,
      });
    }
    return defs.length > 0 ? defs : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider metadata (service tier, inference geo, etc.)
// ---------------------------------------------------------------------------

function parseProviderMetadata(
  raw: unknown
): { serviceTier?: string; resolvedProvider?: string; gatewayCost?: string } | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;

    let serviceTier: string | undefined;
    let resolvedProvider: string | undefined;
    let gatewayCost: string | undefined;

    // Anthropic: { anthropic: { usage: { service_tier: "standard" } } }
    const anthropic = rec(parsed.anthropic);
    serviceTier = str(rec(anthropic.usage).service_tier);

    // Azure/OpenAI: { azure: { serviceTier: "default" } } or { openai: { serviceTier: "..." } }
    if (!serviceTier) {
      serviceTier = str(rec(parsed.azure).serviceTier) ?? str(rec(parsed.openai).serviceTier);
    }

    // Gateway: { gateway: { routing: { finalProvider, resolvedProvider }, cost } }
    const gateway = rec(parsed.gateway);
    const routing = rec(gateway.routing);
    resolvedProvider = str(routing.finalProvider) ?? str(routing.resolvedProvider);
    gatewayCost = str(gateway.cost);

    // OpenRouter: { openrouter: { provider: "xAI" } }
    if (!resolvedProvider) {
      resolvedProvider = str(rec(parsed.openrouter).provider);
    }

    if (!serviceTier && !resolvedProvider && !gatewayCost) return undefined;
    return { serviceTier, resolvedProvider, gatewayCost };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tool choice parsing
// ---------------------------------------------------------------------------

function parseToolChoice(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.type === "string") return obj.type;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Message count
// ---------------------------------------------------------------------------

function countMessages(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.length > 0 ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Telemetry metadata
// ---------------------------------------------------------------------------

function extractTelemetryMetadata(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
