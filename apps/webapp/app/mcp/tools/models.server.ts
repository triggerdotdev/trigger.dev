import { $replica } from "~/db.server";
import {
  ModelRegistryPresenter,
  type ModelCatalogItem,
  type ModelDetail,
  type ProjectModelUsageItem,
  type UserModelMetrics,
} from "~/presenters/v3/ModelRegistryPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { formatModelCost, formatModelPrice } from "~/utils/modelFormatters";
import { parsePeriodToMs } from "~/utils/periods";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, textResult } from "./define.server";
import {
  fenced,
  isoDate,
  isoTime,
  MODEL_NAME,
  plainError,
  plainOr,
  plural,
} from "./format/insights";
import { subjectEnvironment } from "./query.server";
import { NONE_FOUND, READ_BUDGET_MS, startReadBudget, stoppedText } from "./readBudget.server";
import { GetModelInput, ListModelsInput, ModelUsageInput } from "./schemas/models";

const MODEL_ID = /^llm_model_[A-Za-z0-9]{1,64}$/;
const SLUG = /^[a-z0-9_]{1,64}$/;
const USAGE_DAYS = 7;

const catalogPresenter = () => new ModelRegistryPresenter(undefined as never, $replica);

async function usagePresenter(organizationId: string) {
  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    organizationId,
    "standard"
  );
  return new ModelRegistryPresenter(clickhouse, $replica);
}

const modelName = (name: string) => plainOr(name, MODEL_NAME, "model-name");
const slug = (value: string) => plainOr(value, SLUG, "model-slug");
const tokens = (count: number | null) =>
  count === null ? "unknown" : `${count.toLocaleString("en-US")} tokens`;
const price = (label: string, perToken: number | null) =>
  perToken === null ? `${label} price unknown` : `${label} ${formatModelPrice(perToken)}/1M tokens`;

function catalogLine(model: ModelCatalogItem): string {
  const parts = [
    `context ${tokens(model.contextWindow)}`,
    `max output ${tokens(model.maxOutputTokens)}`,
    price("input", model.inputPrice),
    price("output", model.outputPrice),
    `released ${isoDate(model.releaseDate)}`,
  ];
  const lines = [
    `- ${plainOr(model.friendlyId, MODEL_ID, "model-id")} ${slug(model.provider)}:${modelName(model.modelName)} (${parts.join(", ")})`,
  ];
  if (model.features.length > 0) lines.push(`  Features: ${model.features.map(slug).join(", ")}`);
  if (model.variants.length > 0) {
    lines.push(
      `  Variants: ${model.variants.map((v) => `${modelName(v.modelName)} (${plainOr(v.friendlyId, MODEL_ID, "model-id")})`).join(", ")}`
    );
  }
  return lines.join("\n");
}

function formatDetail(model: ModelDetail, usage: UserModelMetrics): string {
  const lines = [
    `## ${slug(model.provider)}:${modelName(model.modelName)} (id: ${model.friendlyId})`,
    "",
    model.description ? fenced(model.description, "model-description", 2_000) : "No description.",
    `Context window: ${tokens(model.contextWindow)}; max output: ${tokens(model.maxOutputTokens)}; released ${isoDate(model.releaseDate)}`,
    `Matches response models by pattern: ${fenced(model.matchPattern, "model-pattern")}; source: ${slug(model.source)}`,
  ];
  if (model.features.length > 0) lines.push(`Features: ${model.features.map(slug).join(", ")}`);

  lines.push("", "### Pricing (per 1M units)");
  for (const tier of model.pricingTiers) {
    const prices = Object.entries(tier.prices)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([usage, price]) => `${slug(usage)} ${formatModelPrice(price)}`);
    lines.push(
      `- ${fenced(tier.name, "pricing-tier")}${tier.isDefault ? " (default)" : ""}: ${prices.join(", ") || "no prices"}`
    );
  }

  lines.push("", `### Your usage in this environment, last ${USAGE_DAYS} days`);
  if (usage.totalCalls === 0) {
    lines.push(NONE_FOUND);
    return lines.join("\n");
  }
  lines.push(
    `Calls: ${usage.totalCalls}; cost: ${formatModelCost(usage.totalCost)}; input tokens: ${usage.totalInputTokens}; output tokens: ${usage.totalOutputTokens}; average time to first chunk: ${usage.avgTtfc}ms; average tokens per second: ${usage.avgTps}`
  );
  for (const task of usage.taskBreakdown) {
    lines.push(
      `- ${fenced(task.taskIdentifier, "task")}: ${plural(task.calls, "call")}, ${formatModelCost(task.cost)}`
    );
  }
  return lines.join("\n");
}

function usageLine(item: ProjectModelUsageItem): string {
  const cacheRate =
    item.inputTokens > 0
      ? `${((item.cachedReadTokens / item.inputTokens) * 100).toFixed(1)}%`
      : "-";
  return `- ${modelName(item.responseModel)} (${slug(item.genAiSystem)}): ${plural(item.calls, "call")}, ${formatModelCost(item.totalCost)}, ${item.totalTokens} tokens, average time to first chunk ${item.avgTtfc}ms, ${item.avgTps} tokens per second, cache read rate ${cacheRate}`;
}

export function createModelsTools({
  budgetMs = READ_BUDGET_MS,
}: { budgetMs?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "list_models",
      title: "List Models",
      description:
        "List the public LLM model catalogue, as the Models page shows it (models defined only in your project are not listed; get_model reads those by id): each model's id, provider, context window, prices per 1M tokens, release date, features and dated variants. Filter by provider or name; use get_model for one model's pricing tiers and your usage of it.",
      shape: ListModelsInput.shape,
      auth: { action: "read", subject: "query" },
      run: async (input, ctx) => {
        const environment = await subjectEnvironment(ctx);
        if (!environment) return plainError("Environment not found");

        const search = input.search?.toLowerCase();
        const models = (await catalogPresenter().getModelCatalog())
          .flatMap((group) => group.models)
          .filter((m) => !input.provider || m.provider === input.provider.toLowerCase())
          .filter((m) => !search || m.displayId.toLowerCase().includes(search));
        if (models.length === 0) return textResult("No models match.");

        const page = models.slice(input.offset, input.offset + input.limit);
        const end = input.offset + page.length;
        const lines = [
          `## Public model catalogue ${input.offset + 1}-${end} of ${models.length}`,
          "",
          ...page.map(catalogLine),
        ];
        if (end < models.length) lines.push("", `More models: call again with offset ${end}.`);
        return textResult(lines.join("\n"));
      },
    }),
    defineReadTool({
      name: "get_model",
      title: "Get Model",
      description: `Get one LLM model from the catalogue: its description, context window, pricing tiers and response-model pattern, plus this environment's usage of it over the last ${USAGE_DAYS} days (calls, cost, tokens, latency and the tasks that called it).`,
      shape: GetModelInput.shape,
      auth: { action: "read", subject: "query" },
      run: async (input, ctx) => {
        const budget = startReadBudget(budgetMs, ctx.signal);
        const found = await budget.read(() => subjectEnvironment(ctx));
        if (!found.ok) return plainError(stoppedText(found));
        const environment = found.value;
        if (!environment) return plainError("Environment not found");

        const visible = await budget.read(() =>
          $replica.llmModel.findFirst({
            where: {
              friendlyId: input.modelId,
              OR: [{ projectId: null }, { projectId: environment.projectId }],
            },
            select: { id: true },
          })
        );
        if (!visible.ok) return plainError(stoppedText(visible));
        const detail = visible.value
          ? await budget.read(() => catalogPresenter().getModelDetail(input.modelId))
          : ({ ok: true, value: null } as const);
        if (!detail.ok) return plainError(stoppedText(detail));
        const model = detail.value;
        if (!model) {
          return plainError(
            `Model ${plainOr(input.modelId, MODEL_ID, "model-id")} not found; list_models lists the public catalogue, not models defined only in your project.`
          );
        }

        const to = new Date();
        const from = new Date(to.getTime() - USAGE_DAYS * 86_400_000);
        const presenter = await budget.read(() => usagePresenter(environment.organizationId));
        if (!presenter.ok) return plainError(stoppedText(presenter));
        const usage = await budget.read(() =>
          presenter.value.getUserMetrics(
            model.modelName,
            environment.projectId,
            environment.id,
            from,
            to,
            budget.limit()
          )
        );
        if (!usage.ok) return plainError(stoppedText(usage));
        return textResult(formatDetail(model, usage.value));
      },
    }),
    defineReadTool({
      name: "get_model_usage",
      title: "Get Model Usage",
      description:
        "List the LLM models this environment called over a period, most calls first, as the Models page's Your models tab shows them: calls, cost, tokens, average latency, tokens per second and cache read rate per model.",
      shape: ModelUsageInput.shape,
      auth: { action: "read", subject: "query" },
      run: async (input, ctx) => {
        const budget = startReadBudget(budgetMs, ctx.signal);
        const found = await budget.read(() => subjectEnvironment(ctx));
        if (!found.ok) return plainError(stoppedText(found));
        const environment = found.value;
        if (!environment) return plainError("Environment not found");

        const to = new Date();
        const from = new Date(to.getTime() - parsePeriodToMs(input.period));
        const presenter = await budget.read(() => usagePresenter(environment.organizationId));
        if (!presenter.ok) return plainError(stoppedText(presenter));
        const usage = await budget.read(() =>
          presenter.value.getProjectModelUsage(
            environment.projectId,
            environment.id,
            from,
            to,
            budget.limit()
          )
        );
        if (!usage.ok) return plainError(stoppedText(usage));

        const header = `this environment from ${isoTime(from)} to ${isoTime(to)}`;
        if (usage.value.length === 0) {
          return textResult(`Model calls in ${header}: ${NONE_FOUND}`);
        }
        return textResult(
          [`## Model usage in ${header}`, "", ...usage.value.map(usageLine)].join("\n")
        );
      },
    }),
  ];
}

export const modelsTools: McpToolDefinition[] = createModelsTools();
