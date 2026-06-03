import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  getMissingModelSamples,
  type MissingModelSample,
} from "~/services/admin/missingLlmModels.server";

const ParamsSchema = z.object({
  model: z.string(),
});

export const loader = dashboardLoader(
  { authorization: { requireSuper: true }, params: ParamsSchema },
  async ({ params, request }) => {
    // Model name is URL-encoded in the URL param
    const modelName = decodeURIComponent(params.model);
    if (!modelName) throw new Response("Missing model param", { status: 400 });

    const url = new URL(request.url);
    const lookbackHours = parseInt(url.searchParams.get("lookbackHours") ?? "24", 10);

    let samples: MissingModelSample[] = [];
    let error: string | undefined;

    try {
      samples = await getMissingModelSamples({ model: modelName, lookbackHours, limit: 10 });
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to query ClickHouse";
    }

    return typedjson({ modelName, samples, lookbackHours, error });
  }
);

export default function AdminMissingModelDetailRoute() {
  const { modelName, samples, lookbackHours, error } = useTypedLoaderData<typeof loader>();
  const [copied, setCopied] = useState(false);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());

  const providerCosts = extractProviderCosts(samples);
  const prompt = buildPrompt(modelName, samples, providerCosts);

  function handleCopy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function toggleSpan(spanId: string) {
    setExpandedSpans((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }

  // Extract key token fields from the first sample for quick summary
  const tokenSummary = samples.length > 0 ? extractTokenTypes(samples) : [];

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="max-w-5xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-text-bright font-mono">{modelName}</h2>
            <Paragraph className="text-text-dimmed">
              Missing pricing — {samples.length} sample span{samples.length !== 1 ? "s" : ""} from
              last {lookbackHours}h
            </Paragraph>
          </div>
          <div className="flex items-center gap-2">
            <LinkButton
              to={`/admin/llm-models/new?modelName=${encodeURIComponent(modelName)}`}
              variant="primary/small"
            >
              Add pricing
            </LinkButton>
            <LinkButton to="/admin/llm-models/missing" variant="tertiary/small">
              Back to missing
            </LinkButton>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Token types summary */}
        {tokenSummary.length > 0 && (
          <div className="rounded-md border border-grid-dimmed bg-charcoal-800 p-3 space-y-2">
            <span className="text-xs font-medium text-text-dimmed">
              Token types seen across samples
            </span>
            <div className="flex flex-wrap gap-2">
              {tokenSummary.map((t) => (
                <span
                  key={t.key}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-charcoal-700 px-2 py-1 text-xs font-mono"
                >
                  <span className="text-text-bright">{t.key}</span>
                  <span className="text-text-dimmed">
                    {t.min === t.max ? t.min.toLocaleString() : `${t.min.toLocaleString()}-${t.max.toLocaleString()}`}
                  </span>
                </span>
              ))}
            </div>
            <Paragraph className="text-text-dimmed text-xs">
              These are the token usage types that need pricing entries (at minimum: input, output).
            </Paragraph>
          </div>
        )}

        {/* Provider-reported costs */}
        {providerCosts.length > 0 && (
          <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2">
            <span className="text-xs font-medium text-green-400">
              Provider-reported cost data found in {providerCosts.length} span{providerCosts.length !== 1 ? "s" : ""}
            </span>
            <div className="space-y-1">
              {providerCosts.map((c, i) => (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <span className="text-text-dimmed">{c.source}</span>
                  <span className="font-mono text-text-bright">${c.cost.toFixed(6)}</span>
                  <span className="text-text-dimmed">
                    ({c.inputTokens.toLocaleString()} in + {c.outputTokens.toLocaleString()} out)
                  </span>
                </div>
              ))}
            </div>
            {providerCosts[0]?.estimatedInputPrice != null && (
              <div className="border-t border-green-500/20 pt-2 text-xs">
                <span className="text-green-300">
                  Estimated per-token rates (assuming ~3x output/input ratio):
                </span>
                <div className="flex gap-4 mt-1 font-mono text-text-bright">
                  <span>input: {providerCosts[0].estimatedInputPrice.toExponential(4)}</span>
                  <span>output: {(providerCosts[0].estimatedOutputPrice ?? 0).toExponential(4)}</span>
                </div>
                <span className="text-text-dimmed mt-1 block">
                  Cross-reference with the provider's pricing page before using these estimates.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Prompt section */}
        <div className="rounded-md border border-grid-dimmed bg-charcoal-800 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-dimmed">
              Claude Code prompt — paste this to have it add pricing for this model
            </span>
            <Button variant="tertiary/small" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy prompt"}
            </Button>
          </div>
          <pre className="max-h-64 overflow-auto rounded bg-charcoal-900 p-3 text-xs text-text-dimmed font-mono whitespace-pre-wrap">
            {prompt}
          </pre>
        </div>

        {/* Sample spans */}
        <div className="space-y-2">
          <span className="text-sm font-medium text-text-bright">
            Sample spans ({samples.length})
          </span>
          {samples.map((s) => {
            const expanded = expandedSpans.has(s.span_id);
            let parsedAttrs: Record<string, unknown> | null = null;
            try {
              parsedAttrs = JSON.parse(s.attributes_text) as Record<string, unknown>;
            } catch {
              // ignore
            }

            return (
              <div
                key={s.span_id}
                className="rounded-md border border-grid-dimmed bg-charcoal-800"
              >
                <button
                  type="button"
                  onClick={() => toggleSpan(s.span_id)}
                  className="w-full flex items-center justify-between p-3 text-left hover:bg-charcoal-750"
                >
                  <div className="flex items-center gap-3 text-xs">
                    <span className="font-mono text-text-dimmed">{s.span_id.slice(0, 8)}</span>
                    <span className="text-text-bright">{s.message}</span>
                    <span className="text-text-dimmed">{s.run_id}</span>
                  </div>
                  <span className="text-xs text-text-dimmed">{expanded ? "▼" : "▶"}</span>
                </button>
                {expanded && parsedAttrs && (
                  <div className="border-t border-grid-dimmed p-3">
                    <pre className="max-h-96 overflow-auto text-xs text-text-dimmed font-mono whitespace-pre-wrap">
                      {JSON.stringify(parsedAttrs, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Extract unique token usage types across all samples
// ---------------------------------------------------------------------------

type TokenTypeSummary = { key: string; min: number; max: number };

function extractTokenTypes(samples: MissingModelSample[]): TokenTypeSummary[] {
  const stats = new Map<string, { min: number; max: number }>();

  for (const s of samples) {
    let attrs: Record<string, unknown>;
    try {
      attrs = JSON.parse(s.attributes_text) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Collect from gen_ai.usage.*
    const genAiUsage = getNestedObj(attrs, ["gen_ai", "usage"]);
    if (genAiUsage) {
      for (const [k, v] of Object.entries(genAiUsage)) {
        if (typeof v === "number" && v > 0) {
          const existing = stats.get(`gen_ai.usage.${k}`);
          if (existing) {
            existing.min = Math.min(existing.min, v);
            existing.max = Math.max(existing.max, v);
          } else {
            stats.set(`gen_ai.usage.${k}`, { min: v, max: v });
          }
        }
      }
    }

    // Collect from ai.usage.*
    const aiUsage = getNestedObj(attrs, ["ai", "usage"]);
    if (aiUsage) {
      for (const [k, v] of Object.entries(aiUsage)) {
        if (typeof v === "number" && v > 0) {
          const existing = stats.get(`ai.usage.${k}`);
          if (existing) {
            existing.min = Math.min(existing.min, v);
            existing.max = Math.max(existing.max, v);
          } else {
            stats.set(`ai.usage.${k}`, { min: v, max: v });
          }
        }
      }
    }
  }

  return Array.from(stats.entries())
    .map(([key, { min, max }]) => ({ key, min, max }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function getNestedObj(
  obj: Record<string, unknown>,
  path: string[]
): Record<string, unknown> | null {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" ? (current as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Extract provider-reported costs from providerMetadata
// ---------------------------------------------------------------------------

type ProviderCostInfo = {
  source: string; // "gateway" or "openrouter"
  cost: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputPrice?: number;  // per-token estimate
  estimatedOutputPrice?: number; // per-token estimate
};

function extractProviderCosts(samples: MissingModelSample[]): ProviderCostInfo[] {
  const costs: ProviderCostInfo[] = [];

  for (const s of samples) {
    let attrs: Record<string, unknown>;
    try {
      attrs = JSON.parse(s.attributes_text) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Parse providerMetadata — could be nested or stringified
    let providerMeta: Record<string, unknown> | null = null;
    const aiResponse = getNestedObj(attrs, ["ai", "response"]);
    const rawMeta = aiResponse?.providerMetadata;
    if (typeof rawMeta === "string") {
      try { providerMeta = JSON.parse(rawMeta) as Record<string, unknown>; } catch {}
    } else if (rawMeta && typeof rawMeta === "object") {
      providerMeta = rawMeta as Record<string, unknown>;
    }
    if (!providerMeta) continue;

    // Get token counts
    const genAiUsage = getNestedObj(attrs, ["gen_ai", "usage"]);
    const inputTokens = Number(genAiUsage?.input_tokens ?? 0);
    const outputTokens = Number(genAiUsage?.output_tokens ?? 0);
    if (inputTokens === 0 && outputTokens === 0) continue;

    // Gateway: { gateway: { cost: "0.0006615" } }
    const gw = getNestedObj(providerMeta, ["gateway"]);
    if (gw) {
      const cost = parseFloat(String(gw.cost ?? "0"));
      if (cost > 0) {
        costs.push({ source: "gateway", cost, inputTokens, outputTokens });
        continue;
      }
    }

    // OpenRouter: { openrouter: { usage: { cost: 0.000135 } } }
    const or = getNestedObj(providerMeta, ["openrouter"]);
    const orUsage = or ? getNestedObj(or, ["usage"]) : null;
    if (orUsage) {
      const cost = Number(orUsage.cost ?? 0);
      if (cost > 0) {
        costs.push({ source: "openrouter", cost, inputTokens, outputTokens });
        continue;
      }
    }
  }

  // Estimate per-token prices from aggregate costs if we have enough data
  if (costs.length > 0) {
    // Use least-squares to estimate input/output price from cost = input*pi + output*po
    // With 2+ samples we can solve; with 1 we can only estimate a blended rate
    const totalInput = costs.reduce((s, c) => s + c.inputTokens, 0);
    const totalOutput = costs.reduce((s, c) => s + c.outputTokens, 0);
    const totalCost = costs.reduce((s, c) => s + c.cost, 0);

    if (totalInput > 0 && totalOutput > 0) {
      // Simple approach: assume output is 2-5x input price (common ratio)
      // Use ratio r where output_price = r * input_price
      // totalCost = input_price * (totalInput + r * totalOutput)
      // Try r=3 (common for many models)
      const r = 3;
      const estimatedInputPrice = totalCost / (totalInput + r * totalOutput);
      const estimatedOutputPrice = estimatedInputPrice * r;

      for (const c of costs) {
        c.estimatedInputPrice = estimatedInputPrice;
        c.estimatedOutputPrice = estimatedOutputPrice;
      }
    }
  }

  return costs;
}

// ---------------------------------------------------------------------------
// Prompt builder — focused on figuring out pricing, not API mechanics
// ---------------------------------------------------------------------------

function buildPrompt(modelName: string, samples: MissingModelSample[], providerCosts: ProviderCostInfo[]): string {
  const hasPrefix = modelName.includes("/");
  const prefix = hasPrefix ? modelName.split("/")[0] : null;
  const baseName = hasPrefix ? modelName.split("/").slice(1).join("/") : modelName;

  // Extract token types from samples
  const tokenTypes = extractTokenTypes(samples);
  const tokenTypeList = tokenTypes.length > 0
    ? tokenTypes.map((t) => `  - ${t.key}: ${t.min === t.max ? t.min : `${t.min}-${t.max}`}`).join("\n")
    : "  (no token data found in samples)";

  // Get a compact sample of attributes for context
  let sampleAttrs = "";
  if (samples.length > 0) {
    try {
      const attrs = JSON.parse(samples[0].attributes_text) as Record<string, unknown>;
      const ai = attrs.ai as Record<string, unknown> | undefined;
      const aiResponse = (ai?.response ?? {}) as Record<string, unknown>;
      // Extract just the relevant fields
      const compact: Record<string, unknown> = {};
      if (attrs.gen_ai) compact.gen_ai = attrs.gen_ai;
      if (ai?.usage) compact["ai.usage"] = ai.usage;
      if (aiResponse.providerMetadata) {
        compact["ai.response.providerMetadata"] = aiResponse.providerMetadata;
      }
      sampleAttrs = JSON.stringify(compact, null, 2);
    } catch {
      // ignore
    }
  }

  // Build suggested regex
  const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suggestedPattern = prefix
    ? `(?i)^(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/)?(${escapedBase})$`
    : `(?i)^(${escapedBase})$`;

  return `I need to add LLM pricing for the model "${modelName}".

## Model info
- Full model string from spans: \`${modelName}\`
- Base model name: \`${baseName}\`${prefix ? `\n- Provider prefix: \`${prefix}\`` : ""}
- This model appears in production spans but has no pricing data.

## Token types seen in spans
${tokenTypeList}

## What I need you to do

1. **Look up pricing**: Find the current per-token pricing for \`${baseName}\` from the provider's official pricing page. Search the web if needed.

2. **Present the pricing to me** in the following format so I can review before adding:

\`\`\`
Model name: ${baseName}
Match pattern: ${suggestedPattern}
Pricing tier: Standard

Prices (per token):
  input: <cost per input token>
  output: <cost per output token>
  (add any additional token types if applicable)
\`\`\`

**IMPORTANT: Do NOT call the admin API or create the model yourself.** Just research the pricing and present it to me. I will add it via the admin dashboard or ask you to proceed once I've reviewed.

## Pricing research notes

- All prices should be in **cost per token** (NOT per million). To convert: divide $/M by 1,000,000.
  - Example: $3.00/M tokens = 0.000003 per token
- The \`matchPattern\` regex should match the model name both with and without the provider prefix.
  - Suggested: \`${suggestedPattern}\`
  - This matches both \`${baseName}\` and \`${modelName}\`
- Based on the token types seen in spans, check if the provider charges differently for:
  - \`input\` and \`output\` — always required
  - \`input_cached_tokens\` — if the provider offers prompt caching discounts
  - \`cache_creation_input_tokens\` — if there's a cache write cost
  - \`reasoning_tokens\` — if the model has chain-of-thought/reasoning tokens${providerCosts.length > 0 ? `

## Provider-reported costs (from ${providerCosts[0].source})
The gateway/router is reporting costs for this model. Use these to cross-reference your pricing:
${providerCosts.map((c) => `- $${c.cost.toFixed(6)} for ${c.inputTokens.toLocaleString()} input + ${c.outputTokens.toLocaleString()} output tokens`).join("\n")}${providerCosts[0].estimatedInputPrice != null ? `
- Estimated per-token rates (rough, assuming ~3x output/input ratio):
  - input: ${providerCosts[0].estimatedInputPrice.toExponential(4)} (${(providerCosts[0].estimatedInputPrice * 1_000_000).toFixed(4)} $/M)
  - output: ${(providerCosts[0].estimatedOutputPrice ?? 0).toExponential(4)} (${((providerCosts[0].estimatedOutputPrice ?? 0) * 1_000_000).toFixed(4)} $/M)
- Verify these against the official pricing page before using.` : ""}` : ""}${sampleAttrs ? `

## Sample span attributes (first span)
\`\`\`json
${sampleAttrs}
\`\`\`` : ""}`;
}
