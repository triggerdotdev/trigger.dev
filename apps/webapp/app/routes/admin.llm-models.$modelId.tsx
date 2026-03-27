import { Form, useActionData, useNavigate } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { useState } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.admin) throw redirect("/");

  const model = await prisma.llmModel.findUnique({
    where: { friendlyId: params.modelId },
    include: {
      pricingTiers: { include: { prices: true }, orderBy: { priority: "asc" } },
    },
  });

  if (!model) throw new Response("Model not found", { status: 404 });

  // Convert Prisma Decimal to plain numbers for serialization
  const serialized = {
    ...model,
    pricingTiers: model.pricingTiers.map((t) => ({
      ...t,
      prices: t.prices.map((p) => ({ ...p, price: Number(p.price) })),
    })),
  };

  return typedjson({ model: serialized });
};

const SaveSchema = z.object({
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

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.admin) throw redirect("/");

  const friendlyId = params.modelId!;
  const existing = await prisma.llmModel.findUnique({ where: { friendlyId } });
  if (!existing) throw new Response("Model not found", { status: 404 });
  const modelId = existing.id;

  const formData = await request.formData();
  const _action = formData.get("_action");

  if (_action === "delete") {
    await prisma.llmModel.delete({ where: { id: modelId } });
    await llmPricingRegistry?.reload();
    return redirect("/admin/llm-models");
  }

  if (_action === "save") {
    const raw = Object.fromEntries(formData);
    const parsed = SaveSchema.safeParse(raw);

    if (!parsed.success) {
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

    // Parse tiers
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

    // Update model
    const { provider, description, contextWindow, maxOutputTokens, capabilities, isHidden } = parsed.data;
    await prisma.llmModel.update({
      where: { id: modelId },
      data: {
        modelName,
        matchPattern,
        provider: provider || null,
        description: description || null,
        contextWindow: contextWindow ? parseInt(contextWindow) || null : null,
        maxOutputTokens: maxOutputTokens ? parseInt(maxOutputTokens) || null : null,
        capabilities: capabilities ? capabilities.split(",").map((s) => s.trim()).filter(Boolean) : [],
        isHidden: isHidden === "on",
      },
    });

    // Replace tiers
    await prisma.llmPricingTier.deleteMany({ where: { modelId } });
    for (const tier of pricingTiers) {
      await prisma.llmPricingTier.create({
        data: {
          modelId,
          name: tier.name,
          isDefault: tier.isDefault,
          priority: tier.priority,
          conditions: tier.conditions,
          prices: {
            create: Object.entries(tier.prices).map(([usageType, price]) => ({
              modelId,
              usageType,
              price,
            })),
          },
        },
      });
    }

    await llmPricingRegistry?.reload();
    return typedjson({ success: true });
  }

  return typedjson({ error: "Unknown action" }, { status: 400 });
}

export default function AdminLlmModelDetailRoute() {
  const { model } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string; details?: unknown[] }>();
  const navigate = useNavigate();

  const [modelName, setModelName] = useState(model.modelName);
  const [matchPattern, setMatchPattern] = useState(model.matchPattern);
  const [provider, setProvider] = useState(model.provider ?? "");
  const [description, setDescription] = useState(model.description ?? "");
  const [contextWindow, setContextWindow] = useState(model.contextWindow?.toString() ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(model.maxOutputTokens?.toString() ?? "");
  const [capabilities, setCapabilities] = useState(model.capabilities?.join(", ") ?? "");
  const [isHidden, setIsHidden] = useState(model.isHidden ?? false);
  const [testInput, setTestInput] = useState("");
  const [tiers, setTiers] = useState(() =>
    model.pricingTiers.map((t) => ({
      name: t.name,
      isDefault: t.isDefault,
      priority: t.priority,
      conditions: (t.conditions ?? []) as Array<{
        usageDetailPattern: string;
        operator: string;
        value: number;
      }>,
      prices: Object.fromEntries(t.prices.map((p) => [p.usageType, p.price])),
    }))
  );

  // Test regex match
  let testResult: boolean | null = null;
  if (testInput) {
    try {
      const pattern = matchPattern.startsWith("(?i)")
        ? matchPattern.slice(4)
        : matchPattern;
      testResult = new RegExp(pattern, "i").test(testInput);
    } catch {
      testResult = null;
    }
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-text-bright">{model.modelName}</h2>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${
                model.source === "admin"
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-charcoal-700 text-text-dimmed"
              }`}
            >
              {model.source ?? "default"}
            </span>
            <LinkButton to="/admin/llm-models" variant="tertiary/small">
              Back to list
            </LinkButton>
          </div>
        </div>

        <Form method="post">
          <input type="hidden" name="_action" value="save" />
          <input type="hidden" name="pricingTiersJson" value={JSON.stringify(tiers)} />

          <div className="space-y-4">
            {/* Model fields */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-dimmed">Model Name</label>
              <Input
                name="modelName"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                variant="medium"
                fullWidth
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-text-dimmed">Match Pattern (regex)</label>
              <Input
                name="matchPattern"
                value={matchPattern}
                onChange={(e) => setMatchPattern(e.target.value)}
                variant="medium"
                fullWidth
                className="font-mono text-xs"
              />
            </div>

            {/* Test pattern */}
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
                  <label className="text-xs font-medium text-text-dimmed">Capabilities (comma-separated)</label>
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

            {/* Actions */}
            <div className="flex items-center gap-2 border-t border-grid-dimmed pt-4">
              <Button type="submit" variant="primary/medium">
                Save
              </Button>
              <LinkButton to="/admin/llm-models" variant="tertiary/medium">
                Cancel
              </LinkButton>
            </div>
          </div>
        </Form>

        {/* Delete section */}
        <div className="border-t border-grid-dimmed pt-4">
          <Form method="post" onSubmit={(e) => {
            if (!confirm(`Delete model "${model.modelName}"?`)) e.preventDefault();
          }}>
            <input type="hidden" name="_action" value="delete" />
            <Button type="submit" variant="danger/small">
              Delete model
            </Button>
          </Form>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Tier editor sub-component
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

      {/* Prices */}
      <div className="space-y-1">
        <span className="text-xs font-medium text-text-dimmed">
          Prices (per token)
        </span>
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
                    onChange({
                      ...tier,
                      prices: { ...tier.prices, [usageType]: val },
                    });
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

        {/* Add price */}
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
                  onChange({
                    ...tier,
                    prices: { ...tier.prices, [key]: 0 },
                  });
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
