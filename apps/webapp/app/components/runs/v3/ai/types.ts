// ---------------------------------------------------------------------------
// Tool use (merged assistant tool-call + tool result)
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  name: string;
  description?: string;
  /** JSON schema as formatted string */
  parametersJson?: string;
};

export type ToolUse = {
  toolCallId: string;
  toolName: string;
  /** Tool description from the definition, if available */
  description?: string;
  /** JSON schema of the tool's parameters, pretty-printed */
  parametersJson?: string;
  /** Formatted input args as JSON string */
  inputJson: string;
  /** Short summary of the result (e.g. "200 · text/html · truncated") */
  resultSummary?: string;
  /** Full formatted result for display in a code block */
  resultOutput?: string;
};

// ---------------------------------------------------------------------------
// Display items — what the UI actually renders
// ---------------------------------------------------------------------------

/** System prompt text (collapsible) */
export type SystemItem = {
  type: "system";
  text: string;
};

/** User message text */
export type UserItem = {
  type: "user";
  text: string;
};

/** One or more tool calls with their results, grouped */
export type ToolUseItem = {
  type: "tool-use";
  tools: ToolUse[];
};

/** Final assistant text response */
export type AssistantItem = {
  type: "assistant";
  text: string;
};

export type DisplayItem = SystemItem | UserItem | ToolUseItem | AssistantItem;

// ---------------------------------------------------------------------------
// Span-level AI data
// ---------------------------------------------------------------------------

export type AISpanData = {
  model: string;
  provider: string;
  operationName: string;

  // Categorical tags
  finishReason?: string;
  serviceTier?: string;
  /** Resolved downstream provider for gateway/openrouter spans (e.g. "xAI", "mistral") */
  resolvedProvider?: string;
  toolChoice?: string;
  toolCount?: number;
  messageCount?: number;
  /** User-defined telemetry metadata (from ai.telemetry.metadata) */
  telemetryMetadata?: Record<string, string>;

  // Token counts
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;

  // Performance
  tokensPerSecond?: number;
  msToFirstChunk?: number;
  durationMs: number;

  // Cost
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;

  // Response text (final assistant output)
  responseText?: string;
  // Structured object response (JSON) — mutually exclusive with responseText
  responseObject?: string;

  // Tool definitions (from ai.prompt.tools)
  toolDefinitions?: ToolDefinition[];

  // Display-ready message items (system, user, tool-use groups, assistant text)
  items?: DisplayItem[];
};
