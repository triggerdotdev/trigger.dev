import { Form, useActionData, useSearchParams } from "@remix-run/react";
import { redirect } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { useState } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { prisma } from "~/db.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async () => {
    return typedjson({});
  }
);

const CreateSchema = z.object({
  modelName: z.string().min(1),
  matchPattern: z.string().min(1),
  pricingTiersJson: z.string(),
  provider: z.string().optional(),
  description: z.string().optional(),
  contextWindow: z.string().optional(),
  maxOutputTokens: z.string().optional(),
  capabilities: z.string().optional(),
  isHidden: z.string().optional(),
});

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const formData = await request.formData();
    const raw = Object.fromEntries(formData);
    console.log("[admin] create model form data:", JSON.stringify(raw).slice(0, 500));
    const parsed = CreateSchema.safeParse(raw);

    if (!parsed.success) {
      console.log("[admin] create model validation error:", JSON.stringify(parsed.error.issues));
      return typedjson({ error: "Invalid form data", details: parsed.error.issues }, { status: 400 });
    }

    const { modelName, matchPattern, pricingTiersJson } = parsed.data;

    // Validate regex — strip (?i) POSIX flag since our registry handles it
    try {
      const testPattern = matchPattern.startsWith("(?i)") ? matchPattern.slice(4) : matchPattern;
      new RegExp(testPattern);
    } catch {
      return typedjson({ error: "Invalid regex in matchPattern" }, { status: 400 });
    }

    let pricingTiers: Array<{
      name: string;
      isDefault: boolean;
      priority: number;
      conditions: Array<{ usageDetailPattern: string; operator: string; value: number }>;
      prices: Record<string, number>;
    }>;
    try {
      pricingTiers = JSON.parse(pricingTiersJson) as typeof pricingTiers;
    } catch {
      return typedjson({ error: "Invalid pricing tiers JSON" }, { status: 400 });
    }

    const { provider, description, contextWindow, maxOutputTokens, capabilities, isHidden } = parsed.data;

    const model = await prisma.llmModel.create({
      data: {
        friendlyId: generateFriendlyId("llm_model"),
        modelName,
        matchPattern,
        source: "admin",
        provider: provider || null,
        description: description || null,
        contextWindow: contextWindow ? parseInt(contextWindow) || null : null,
        maxOutputTokens: maxOutputTokens ? parseInt(maxOutputTokens) || null : null,
        capabilities: capabilities ? capabilities.split(",").map((s) => s.trim()).filter(Boolean) : [],
        isHidden: isHidden === "on",
      },
    });

    for (const tier of pricingTiers) {
      await prisma.llmPricingTier.create({
        data: {
          modelId: model.id,
          name: tier.name,
          isDefault: tier.isDefault,
          priority: tier.priority,
          conditions: tier.conditions,
          prices: {
            create: Object.entries(tier.prices).map(([usageType, price]) => ({
              modelId: model.id,
              usageType,
              price,
            })),
          },
        },
      });
    }

    await llmPricingRegistry?.reload();
    return redirect(`/admin/llm-models/${model.friendlyId}`);
  }
);

export default function AdminLlmModelNewRoute() {
  const actionData = useActionData<{ error?: string; details?: unknown[] }>();
  const [params] = useSearchParams();
  const initialModelName = params.get("modelName") ?? "";
  const [modelName, setModelName] = useState(initialModelName);
  const [matchPattern, setMatchPattern] = useState("");
  const [provider, setProvider] = useState("");
  const [description, setDescription] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [isHidden, setIsHidden] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [tiers, setTiers] = useState<TierData[]>([
    { name: "Standard", isDefault: true, priority: 0, conditions: [], prices: { input: 0, output: 0 } },
  ]);

  let testResult: boolean | null = null;
  if (testInput && matchPattern) {
    try {
      const pattern = matchPattern.startsWith("(?i)")
        ? matchPattern.slice(4)
        : matchPattern;
      testResult = new RegExp(pattern, "i").test(testInput);
    } catch {
      testResult = null;
    }
  }

  // Auto-generate match pattern from model name
  function autoPattern() {
    if (modelName) {
      const escaped = modelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      setMatchPattern(`(?i)^(${escaped})$`);
    }
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-text-bright">New LLM Model</h2>
          <LinkButton to="/admin/llm-models" variant="tertiary/small">
            Back to list
          </LinkButton>
        </div>

        <Form method="post">
          <input type="hidden" name="pricingTiersJson" value={JSON.stringify(tiers)} />

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-dimmed">Model Name</label>
              <Input
                name="modelName"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                variant="medium"
                fullWidth
                placeholder="e.g. gemini-3-flash"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-text-dimmed">Match Pattern (regex)</label>
                <button
                  type="button"
                  onClick={autoPattern}
                  className="text-xs text-indigo-400 hover:text-indigo-300"
                >
                  Auto-generate from name
                </button>
              </div>
              <Input
                name="matchPattern"
                value={matchPattern}
                onChange={(e) => setMatchPattern(e.target.value)}
                variant="medium"
                fullWidth
                className="font-mono text-xs"
                placeholder="(?i)^(google/)?(gemini-3-flash)$"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-text-dimmed">Test pattern match</label>
              <div className="flex items-center gap-2">
                <Input
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder="Type a model name to test..."
                  variant="medium"
                  fullWidth
                />
                {testInput && (
                  <span
                    className={`text-xs font-medium ${
                      testResult ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {testResult ? "Match" : "No match"}
                  </span>
                )}
              </div>
            </div>

            {/* Catalog metadata */}
            <div className="space-y-2 border-t border-grid-dimmed pt-4">
              <label className="text-sm font-medium text-text-bright">Catalog Metadata</label>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-dimmed">Provider</label>
                  <Input
                    name="provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    variant="medium"
                    fullWidth
                    placeholder="openai, anthropic, google"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-dimmed">Context Window</label>
                  <Input
                    name="contextWindow"
                    value={contextWindow}
                    onChange={(e) => setContextWindow(e.target.value)}
                    variant="medium"
                    fullWidth
                    placeholder="128000"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-text-dimmed">Description</label>
                <Input
                  name="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  variant="medium"
                  fullWidth
                  placeholder="Brief model description"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-dimmed">Max Output Tokens</label>
                  <Input
                    name="maxOutputTokens"
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(e.target.value)}
                    variant="medium"
                    fullWidth
                    placeholder="16384"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-dimmed">Features (comma-separated)</label>
                  <Input
                    name="capabilities"
                    value={capabilities}
                    onChange={(e) => setCapabilities(e.target.value)}
                    variant="medium"
                    fullWidth
                    placeholder="vision, tool_use, streaming, json_mode"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-text-dimmed">
                <input
                  type="checkbox"
                  name="isHidden"
                  checked={isHidden}
                  onChange={(e) => setIsHidden(e.target.checked)}
                />
                Hidden (exclude from model registry)
              </label>
            </div>

            {/* Pricing tiers */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-bright">Pricing Tiers</label>
                <Button
                  type="button"
                  variant="tertiary/small"
                  onClick={() =>
                    setTiers([
                      ...tiers,
                      {
                        name: `Tier ${tiers.length + 1}`,
                        isDefault: tiers.length === 0,
                        priority: tiers.length,
                        conditions: [],
                        prices: {},
                      },
                    ])
                  }
                >
                  Add tier
                </Button>
              </div>

              {tiers.map((tier, tierIdx) => (
                <TierEditor
                  key={tierIdx}
                  tier={tier}
                  onChange={(updated) => {
                    const next = [...tiers];
                    next[tierIdx] = updated;
                    setTiers(next);
                  }}
                  onRemove={() => setTiers(tiers.filter((_, i) => i !== tierIdx))}
                />
              ))}
            </div>

            {actionData?.error && (
              <div className="rounded-md bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-400">
                {actionData.error}
                {actionData.details && (
                  <pre className="mt-1 text-xs text-red-300/70 overflow-auto">
                    {JSON.stringify(actionData.details, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-grid-dimmed pt-4">
              <Button type="submit" variant="primary/medium">
                Create model
              </Button>
              <LinkButton to="/admin/llm-models" variant="tertiary/medium">
                Cancel
              </LinkButton>
            </div>
          </div>
        </Form>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Shared tier editor (duplicated from detail page — could be extracted later)
// ---------------------------------------------------------------------------

type TierData = {
  name: string;
  isDefault: boolean;
  priority: number;
  conditions: Array<{ usageDetailPattern: string; operator: string; value: number }>;
  prices: Record<string, number>;
};

const COMMON_USAGE_TYPES = [
  "input",
  "output",
  "input_cached_tokens",
  "cache_creation_input_tokens",
  "reasoning_tokens",
];

function TierEditor({
  tier,
  onChange,
  onRemove,
}: {
  tier: TierData;
  onChange: (t: TierData) => void;
  onRemove: () => void;
}) {
  const [newUsageType, setNewUsageType] = useState("");

  return (
    <div className="rounded-md border border-grid-dimmed bg-charcoal-800 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <input
            className="bg-charcoal-750 text-text-bright rounded px-2 py-1 text-sm border border-grid-dimmed"
            value={tier.name}
            onChange={(e) => onChange({ ...tier, name: e.target.value })}
            placeholder="Tier name"
          />
          <label className="flex items-center gap-1 text-xs text-text-dimmed">
            <input
              type="checkbox"
              checked={tier.isDefault}
              onChange={(e) => onChange({ ...tier, isDefault: e.target.checked })}
            />
            Default
          </label>
          <label className="flex items-center gap-1 text-xs text-text-dimmed">
            Priority:
            <input
              type="number"
              className="w-12 bg-charcoal-750 text-text-bright rounded px-1 py-0.5 text-xs border border-grid-dimmed"
              value={tier.priority}
              onChange={(e) => onChange({ ...tier, priority: parseInt(e.target.value) || 0 })}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-red-400 hover:text-red-300"
        >
          Remove tier
        </button>
      </div>

      <div className="space-y-1">
        <span className="text-xs font-medium text-text-dimmed">Prices (per token)</span>
        <div className="space-y-1">
          {Object.entries(tier.prices).map(([usageType, price]) => (
            <div key={usageType} className="flex items-center gap-2">
              <span className="w-48 text-xs font-mono text-text-dimmed">{usageType}</span>
              <input
                type="text"
                className="w-32 bg-charcoal-750 text-text-bright rounded px-2 py-0.5 text-xs font-mono border border-grid-dimmed"
                value={price}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    onChange({ ...tier, prices: { ...tier.prices, [usageType]: val } });
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const { [usageType]: _, ...rest } = tier.prices;
                  onChange({ ...tier, prices: rest });
                }}
                className="text-xs text-red-400 hover:text-red-300"
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <select
            className="bg-charcoal-750 text-text-dimmed rounded px-2 py-0.5 text-xs border border-grid-dimmed"
            value={newUsageType}
            onChange={(e) => setNewUsageType(e.target.value)}
          >
            <option value="">Add price...</option>
            {COMMON_USAGE_TYPES.filter((t) => !(t in tier.prices)).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value="__custom">Custom...</option>
          </select>
          {newUsageType && (
            <Button
              type="button"
              variant="tertiary/small"
              onClick={() => {
                const key =
                  newUsageType === "__custom"
                    ? prompt("Usage type name:") ?? ""
                    : newUsageType;
                if (key) {
                  onChange({ ...tier, prices: { ...tier.prices, [key]: 0 } });
                  setNewUsageType("");
                }
              }}
            >
              Add
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
