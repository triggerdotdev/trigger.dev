/**
 * Pure helpers for OTel attribute truncation and per-span size capping.
 * Lives in a separate module from `otlpExporter.server.ts` so tests can
 * import the helpers without dragging in the env-parsing side effect of
 * the server module's transitive dependencies.
 */

export type AttributeValue = string | number | boolean | undefined;
export type AttributeMap = Record<string, AttributeValue>;

/**
 * Per-key cap overrides for `truncateAttributes`. A key matches an override
 * when `key === prefix` or `key.startsWith(prefix + ".")` — i.e. the prefix
 * covers the attribute itself and any dotted children. First matching entry
 * wins; later entries are ignored.
 */
export type AttributeKeyOverride = { prefix: string; limit: number };

export type SpanAttributeLimits = {
  /** Per-attribute cap applied to every string-valued attribute. */
  defaultValueLengthLimit: number;
  /**
   * Per-attribute cap applied only to known Vercel AI SDK content keys.
   * These attributes (`ai.prompt*`, `ai.response.text/object/toolCalls/reasoning*`,
   * `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.request.messages`,
   * `gen_ai.response.text`) routinely carry tens of KB of user prompt or
   * model response, which is enough to push the assembled per-row JSON past
   * ClickHouse's parse tolerance even after the default 8KB cap.
   */
  aiContentValueLengthLimit: number;
  /**
   * Backstop: if the serialized size of all truncated attributes still
   * exceeds this many bytes, the AI content keys are dropped in priority
   * order until the assembled JSON is under budget. Cost/token metadata is
   * preserved.
   */
  totalAttributesLengthLimit: number;
};

/**
 * Vercel AI SDK content keys to cap aggressively. Keep cost/token metadata
 * out of this list — `ai.usage.*`, `ai.model.*`, `ai.operationId`,
 * `ai.settings.*`, `ai.telemetry.*`, `gen_ai.usage.*`,
 * `gen_ai.response.model`, `gen_ai.request.model`, `gen_ai.system`, and
 * `gen_ai.operation.name` are needed by `enrichCreatableEvents` for cost
 * and LLM enrichment.
 */
export const AI_CONTENT_KEY_OVERRIDES = (limit: number): AttributeKeyOverride[] => [
  // `ai.prompt` covers `ai.prompt`, `ai.prompt.messages`, `ai.prompt.format`,
  // `ai.prompt.tools`, `ai.prompt.toolChoice`, `ai.prompt.system`.
  { prefix: "ai.prompt", limit },
  { prefix: "ai.response.text", limit },
  { prefix: "ai.response.object", limit },
  { prefix: "ai.response.toolCalls", limit },
  { prefix: "ai.response.reasoning", limit },
  { prefix: "ai.response.reasoningDetails", limit },
  { prefix: "gen_ai.prompt", limit },
  { prefix: "gen_ai.completion", limit },
  { prefix: "gen_ai.request.messages", limit },
  { prefix: "gen_ai.response.text", limit },
];

/**
 * Priority list of keys to drop when the assembled attributes JSON exceeds
 * the total-size budget. Higher up = dropped first. Each entry is a prefix
 * (same semantics as `AttributeKeyOverride`).
 */
export const AI_CONTENT_DROP_PRIORITY: string[] = [
  "ai.prompt.messages",
  "ai.prompt",
  "ai.response.object",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.reasoning",
  "ai.response.reasoningDetails",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.request.messages",
  "gen_ai.response.text",
];

function matchKeyOverride(
  key: string,
  overrides: AttributeKeyOverride[] | undefined
): AttributeKeyOverride | undefined {
  if (!overrides) return undefined;
  for (const override of overrides) {
    if (key === override.prefix || key.startsWith(override.prefix + ".")) {
      return override;
    }
  }
  return undefined;
}

export function truncateAttributes(
  attributes: AttributeMap | undefined,
  maximumLength: number = 1024,
  keyOverrides?: AttributeKeyOverride[]
): AttributeMap | undefined {
  if (!attributes) return undefined;

  const truncatedAttributes: AttributeMap = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!key) continue;

    if (typeof value === "string") {
      const override = matchKeyOverride(key, keyOverrides);
      const limit = override ? override.limit : maximumLength;
      truncatedAttributes[key] = truncateAndDetectUnpairedSurrogate(value, limit);
    } else {
      truncatedAttributes[key] = value;
    }
  }

  return truncatedAttributes;
}

/**
 * Backstop applied after per-attribute truncation. If `JSON.stringify(attrs)`
 * is still over `maxBytes`, walk `AI_CONTENT_DROP_PRIORITY` and remove any
 * attributes that match (by `key === prefix` or `key.startsWith(prefix + ".")`)
 * until the assembled size is under budget or the list is exhausted.
 *
 * Returns the original `attributes` reference unchanged when already under
 * budget; otherwise returns a new object with the offending keys removed.
 *
 * If the size is still over budget after exhausting the drop list, calls
 * `onResidualOverflow` (if provided) with the remaining size so the caller
 * can log it. Downstream protection lives in
 * `DynamicFlushScheduler.tryFlush`'s batch-split branch.
 */
export function capAssembledAttributesSize(
  attributes: AttributeMap | undefined,
  maxBytes: number,
  onResidualOverflow?: (info: { remainingBytes: number; maxBytes: number }) => void
): AttributeMap {
  if (!attributes) return {};
  if (maxBytes <= 0) return attributes;

  let serialized = JSON.stringify(attributes);
  if (serialized.length <= maxBytes) return attributes;

  const result: AttributeMap = { ...attributes };

  for (const prefix of AI_CONTENT_DROP_PRIORITY) {
    for (const key of Object.keys(result)) {
      if (key === prefix || key.startsWith(prefix + ".")) {
        delete result[key];
      }
    }
    serialized = JSON.stringify(result);
    if (serialized.length <= maxBytes) return result;
  }

  onResidualOverflow?.({ remainingBytes: serialized.length, maxBytes });
  return result;
}

function truncateAndDetectUnpairedSurrogate(str: string, maximumLength: number): string {
  const truncatedString = smartTruncateString(str, maximumLength);

  if (hasUnpairedSurrogateAtEnd(truncatedString)) {
    return smartTruncateString(truncatedString, [...truncatedString].length - 1);
  }

  return truncatedString;
}

const ASCII_ONLY_REGEX = /^[\p{ASCII}]*$/u;

function smartTruncateString(str: string, maximumLength: number): string {
  if (!str) return "";
  if (str.length <= maximumLength) return str;

  const checkLength = Math.min(str.length, maximumLength * 2 + 2);

  if (ASCII_ONLY_REGEX.test(str.slice(0, checkLength))) {
    return str.slice(0, maximumLength);
  }

  return [...str.slice(0, checkLength)].slice(0, maximumLength).join("");
}

function hasUnpairedSurrogateAtEnd(str: string): boolean {
  if (str.length === 0) return false;

  const lastCode = str.charCodeAt(str.length - 1);

  // Check if last character is an unpaired high surrogate
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return true; // High surrogate at end = unpaired
  }

  // Check if last character is an unpaired low surrogate
  if (lastCode >= 0xdc00 && lastCode <= 0xdfff) {
    // Low surrogate is only valid if preceded by high surrogate
    if (str.length === 1) return true; // Single low surrogate

    const secondLastCode = str.charCodeAt(str.length - 2);
    if (secondLastCode < 0xd800 || secondLastCode > 0xdbff) {
      return true; // Low surrogate not preceded by high surrogate
    }
  }

  return false;
}
