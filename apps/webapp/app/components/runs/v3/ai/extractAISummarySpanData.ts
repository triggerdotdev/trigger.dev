import type { AISpanData, DisplayItem } from "./types";

/**
 * Extracts structured AI data from top-level AI SDK parent spans.
 *
 * These spans (ai.generateText, ai.streamText, ai.generateObject, ai.streamObject)
 * use `ai.*` attributes instead of `gen_ai.*`. They contain the full prompt,
 * aggregated response, and total usage across all steps.
 */
export function extractAISummarySpanData(
  properties: Record<string, unknown>,
  durationMs: number
): AISpanData | undefined {
  const ai = rec(properties.ai);
  if (!ai.operationId) return undefined;

  // Skip child spans that have gen_ai.* (those use extractAISpanData)
  if (properties.gen_ai && typeof properties.gen_ai === "object") return undefined;

  const aiModel = rec(ai.model);
  const aiResponse = rec(ai.response);
  const aiUsage = rec(ai.usage);
  const aiSettings = rec(ai.settings);
  const aiRequest = rec(ai.request);
  const aiTelemetry = rec(ai.telemetry);
  const trigger = rec(properties.trigger);
  const triggerLlm = rec(trigger.llm);

  const model = str(aiModel.id);
  if (!model) return undefined;

  const provider = str(aiModel.provider) ?? "unknown";
  const operationName = str(ai.operationId) ?? "";

  // Token usage
  const inputTokens =
    num(aiUsage.inputTokens) ?? num(aiUsage.promptTokens) ?? 0;
  const outputTokens =
    num(aiUsage.outputTokens) ?? num(aiUsage.completionTokens) ?? 0;
  const totalTokens = num(aiUsage.totalTokens) ?? inputTokens + outputTokens;

  const tokensPerSecond =
    outputTokens > 0 && durationMs > 0
      ? Math.round((outputTokens / (durationMs / 1000)) * 10) / 10
      : undefined;

  // Provider metadata
  const providerMeta = parseProviderMetadata(aiResponse.providerMetadata);

  // Response ID from provider metadata
  const responseId = providerMeta?.responseId;

  // Telemetry metadata (prompt info, custom metadata)
  const telemetryMetaRaw = rec(aiTelemetry.metadata);
  const promptMeta = rec(telemetryMetaRaw.prompt);
  const promptSlug = str(promptMeta.slug);
  const promptVersion = str(promptMeta.version);
  const promptModel = str(promptMeta.model);
  const promptLabels = str(promptMeta.labels);
  const promptInput = str(promptMeta.input);
  const telemetryMeta = extractTelemetryMetadata(aiTelemetry.metadata);

  // Parse the prompt JSON to build display items
  const promptJson = str(ai.prompt);
  const items = promptJson ? parsePromptToDisplayItems(promptJson, str(aiResponse.text)) : undefined;

  // Count messages from the parsed prompt
  let messageCount: number | undefined;
  if (promptJson) {
    try {
      const parsed = JSON.parse(promptJson) as Record<string, unknown>;
      if (parsed.messages && Array.isArray(parsed.messages)) {
        messageCount = parsed.messages.length;
      } else {
        // system + prompt = 2 messages
        messageCount = (parsed.system ? 1 : 0) + (parsed.prompt ? 1 : 0);
      }
    } catch {}
  }

  return {
    model,
    provider,
    operationName,
    responseId,
    finishReason: str(aiResponse.finishReason),
    serviceTier: providerMeta?.serviceTier,
    resolvedProvider: providerMeta?.resolvedProvider,
    toolChoice: undefined,
    toolCount: undefined,
    messageCount,
    telemetryMetadata: telemetryMeta,
    promptSlug: promptSlug || undefined,
    promptVersion: promptVersion || undefined,
    promptModel: promptModel || undefined,
    promptLabels: promptLabels || undefined,
    promptInput: promptInput || undefined,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: num(aiUsage.cachedInputTokens),
    cacheCreationTokens: num(aiUsage.cacheCreationInputTokens),
    reasoningTokens: num(aiUsage.reasoningTokens),
    tokensPerSecond,
    msToFirstChunk: undefined, // Only on child doStream spans
    durationMs,
    inputCost: num(triggerLlm.input_cost),
    outputCost: num(triggerLlm.output_cost),
    totalCost: num(triggerLlm.total_cost),
    responseText: str(aiResponse.text) || undefined,
    responseObject: str(aiResponse.object) || undefined,
    toolDefinitions: undefined,
    items,
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
// Prompt parsing
// ---------------------------------------------------------------------------

/**
 * Parses the `ai.prompt` JSON string into display items.
 * Parent spans store the prompt as a JSON object with either:
 * - { system: "...", prompt: "..." }
 * - { system: "...", messages: [...] }
 * - { messages: [...] }
 */
function parsePromptToDisplayItems(
  promptJson: string,
  responseText?: string
): DisplayItem[] | undefined {
  try {
    const parsed = JSON.parse(promptJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;

    const items: DisplayItem[] = [];

    if (typeof parsed.system === "string" && parsed.system) {
      items.push({ type: "system", text: parsed.system });
    }

    if (typeof parsed.prompt === "string" && parsed.prompt) {
      items.push({ type: "user", text: parsed.prompt });
    }

    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        const role = m.role;
        const content = extractMessageContent(m.content);
        if (!content) continue;

        switch (role) {
          case "system":
            items.push({ type: "system", text: content });
            break;
          case "user":
            items.push({ type: "user", text: content });
            break;
          case "assistant":
            items.push({ type: "assistant", text: content });
            break;
        }
      }
    }

    // Add response as assistant item if not already present
    if (responseText && !items.some((i) => i.type === "assistant")) {
      items.push({ type: "assistant", text: responseText });
    }

    return items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

function extractMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Extract text parts from content array [{type: "text", text: "..."}]
    return content
      .filter((p): p is { type: string; text: string } => {
        if (!p || typeof p !== "object") return false;
        const o = p as Record<string, unknown>;
        return o.type === "text" && typeof o.text === "string";
      })
      .map((p) => p.text)
      .join("\n");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

function parseProviderMetadata(
  raw: unknown
): { serviceTier?: string; resolvedProvider?: string; responseId?: string } | undefined {
  const jsonStr = str(raw);
  if (!jsonStr) return undefined;

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, any>;
    if (!parsed || typeof parsed !== "object") return undefined;

    let serviceTier: string | undefined;
    let responseId: string | undefined;

    // OpenAI
    if (parsed.openai) {
      serviceTier = parsed.openai.serviceTier;
      responseId = parsed.openai.responseId;
    }

    // Anthropic
    if (parsed.anthropic?.usage?.service_tier) {
      serviceTier = parsed.anthropic.usage.service_tier;
    }

    return serviceTier || responseId
      ? { serviceTier, responseId }
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Telemetry metadata
// ---------------------------------------------------------------------------

function extractTelemetryMetadata(
  metadata: unknown
): Record<string, string> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    // Skip prompt metadata (handled separately) and non-string values
    if (key === "prompt") continue;
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
