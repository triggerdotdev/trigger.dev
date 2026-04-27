import { ClickHouse } from "@internal/clickhouse";
import { modelCatalog } from "@internal/llm-model-catalog";
import { PrismaClientOrTransaction } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { z } from "zod";

/** Format a Date for ClickHouse DateTime64 string params. */
function formatDateForCH(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// --- Helpers ---

/** Infer provider from model name when not stored in the DB. */
function inferProvider(modelName: string): string {
  const lower = modelName.toLowerCase();
  // OpenAI
  if (/^(gpt-|o[1-9]|chatgpt|davinci|babbage|curie|ada|text-embedding|text-davinci|text-ada|text-babbage|text-curie|ft:)/.test(lower)) return "openai";
  // Anthropic
  if (lower.startsWith("claude-")) return "anthropic";
  // Google
  if (/^(gemini-|palm-|text-bison|chat-bison|code-bison|codechat-bison|text-unicorn|textembedding-gecko)/.test(lower)) return "google";
  // Meta
  if (/^(llama|code-llama|codellama)/.test(lower)) return "meta";
  // Mistral
  if (/^(mistral|mixtral|codestral|pixtral|ministral)/.test(lower)) return "mistral";
  // xAI
  if (lower.startsWith("grok")) return "xai";
  // DeepSeek
  if (lower.startsWith("deepseek")) return "deepseek";
  // Cohere
  if (/^(command|embed-|rerank-)/.test(lower)) return "cohere";
  // AI21
  if (/^(jamba|j2-)/.test(lower)) return "ai21";
  // Amazon
  if (/^(amazon\.|titan)/.test(lower)) return "amazon";
  // Qwen (Alibaba)
  if (lower.startsWith("qwen")) return "qwen";
  // Perplexity
  if (/^(pplx-|sonar-)/.test(lower)) return "perplexity";
  // Nous
  if (lower.startsWith("nous-")) return "nous";
  // Provider prefix format: "provider/model" (e.g. "openai/gpt-4o")
  if (lower.includes("/")) {
    return lower.split("/")[0];
  }
  return "unknown";
}

/** Format a model as provider:name (e.g. "openai:gpt-5"). */
export function formatModelId(provider: string, modelName: string): string {
  return `${provider}:${modelName}`;
}

// --- Types ---

export type ModelCatalogItem = {
  friendlyId: string;
  modelName: string;
  /** Always resolved — from DB, inferred from name, or "unknown". */
  provider: string;
  /** Display identifier in provider:name format (e.g. "openai:gpt-5"). */
  displayId: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Combined capabilities (from DB) and boolean feature flags (from catalog) as slug strings. */
  features: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  /** When the model was publicly released (from startDate on LlmModel). */
  releaseDate: string | null;
  /** Dated variants of this model (only populated on base models). */
  variants: ModelVariant[];
};

export type ModelVariant = {
  friendlyId: string;
  modelName: string;
  displayId: string;
  releaseDate: string | null;
};

export type ModelCatalogGroup = {
  provider: string;
  models: ModelCatalogItem[];
};

export type ModelDetail = ModelCatalogItem & {
  matchPattern: string;
  source: string;
  pricingTiers: Array<{
    name: string;
    isDefault: boolean;
    prices: Record<string, number>;
  }>;
};

function buildFeatures(
  capabilities: string[],
  catalogEntry: { supportsStructuredOutput: boolean; supportsParallelToolCalls: boolean; supportsStreamingToolCalls: boolean } | undefined
): string[] {
  const features = new Set(capabilities);
  if (catalogEntry?.supportsStructuredOutput) features.add("structured_output");
  if (catalogEntry?.supportsParallelToolCalls) features.add("parallel_tool_calls");
  if (catalogEntry?.supportsStreamingToolCalls) features.add("streaming_tool_calls");
  return Array.from(features);
}

export type ModelMetricsPoint = {
  minute: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  ttfcP50: number;
  ttfcP90: number;
  ttfcP95: number;
  ttfcP99: number;
  tpsP50: number;
  tpsP90: number;
  tpsP95: number;
  tpsP99: number;
  durationP50: number;
  durationP90: number;
  durationP95: number;
  durationP99: number;
};

export type UserModelMetrics = {
  totalCalls: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTtfc: number;
  avgTps: number;
  taskBreakdown: Array<{
    taskIdentifier: string;
    calls: number;
    cost: number;
  }>;
};

export type ModelComparisonItem = {
  responseModel: string;
  genAiSystem: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  ttfcP50: number;
  ttfcP90: number;
  tpsP50: number;
  tpsP90: number;
};

export type PopularModel = {
  responseModel: string;
  genAiSystem: string;
  callCount: number;
  totalCost: number;
  ttfcP50: number;
};

// --- ClickHouse schemas for user metrics ---

const UserMetricsSummaryRow = z.object({
  total_calls: z.coerce.number(),
  total_cost: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  avg_ttfc: z.coerce.number(),
  avg_tps: z.coerce.number(),
});

const UserTaskBreakdownRow = z.object({
  task_identifier: z.string(),
  calls: z.coerce.number(),
  cost: z.coerce.number(),
});

// --- Presenter ---

export class ModelRegistryPresenter extends BasePresenter {
  private readonly clickhouse: ClickHouse;

  constructor(clickhouse: ClickHouse, replica?: PrismaClientOrTransaction) {
    super(undefined, replica);
    this.clickhouse = clickhouse;
  }

  /** List all visible global models with pricing, grouped by provider. */
  async getModelCatalog(): Promise<ModelCatalogGroup[]> {
    const models = await this._replica.llmModel.findMany({
      where: {
        projectId: null,
        isHidden: false,
      },
      include: {
        pricingTiers: {
          where: { isDefault: true },
          include: { prices: true },
          take: 1,
        },
      },
      orderBy: { modelName: "asc" },
    });

    type CatalogItemWithBase = ModelCatalogItem & { _baseModelName: string | null };
    const items: CatalogItemWithBase[] = models.map((m) => {
      const defaultTier = m.pricingTiers[0];
      const prices = defaultTier?.prices ?? [];
      const inputPrice = prices.find((p) => p.usageType === "input");
      const outputPrice = prices.find((p) => p.usageType === "output");
      const provider = m.provider ?? inferProvider(m.modelName);
      const catalogEntry = modelCatalog[m.modelName];

      return {
        friendlyId: m.friendlyId,
        modelName: m.modelName,
        provider,
        displayId: formatModelId(provider, m.modelName),
        description: m.description,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        features: buildFeatures(m.capabilities, catalogEntry),
        inputPrice: inputPrice ? Number(inputPrice.price) : null,
        outputPrice: outputPrice ? Number(outputPrice.price) : null,
        releaseDate: m.startDate ? m.startDate.toISOString().split("T")[0] : null,
        variants: [],
        _baseModelName: m.baseModelName,
      };
    });

    // Normalize version dots for grouping: "3.5" → "3-5", "4.1" → "4-1"
    const normalizeForGrouping = (name: string) => name.replace(/(\d)\.(\d)/g, "$1-$2");

    // Group variants by their normalized base model name
    const variantGroups = new Map<string, CatalogItemWithBase[]>();

    for (const item of items) {
      const groupKey = normalizeForGrouping(item._baseModelName ?? item.modelName);
      const group = variantGroups.get(groupKey) ?? [];
      group.push(item);
      variantGroups.set(groupKey, group);
    }

    // For each group, pick the best representative as the "card" model
    // and nest the rest as variants
    const baseModels: ModelCatalogItem[] = [];

    for (const [groupKey, group] of variantGroups) {
      if (group.length === 1) {
        // Standalone model, no variants
        baseModels.push(group[0]);
        continue;
      }

      // Pick representative: prefer the actual base model (no _baseModelName),
      // then "-latest" variant, then the newest by release date
      let representative = group.find((m) => !m._baseModelName)
        ?? group.find((m) => m.modelName.endsWith("-latest"))
        ?? group.sort((a, b) => {
            if (!a.releaseDate && !b.releaseDate) return 0;
            if (!a.releaseDate) return 1;
            if (!b.releaseDate) return -1;
            return b.releaseDate.localeCompare(a.releaseDate);
          })[0];

      // Nest the others as variants, sorted newest first
      const others = group
        .filter((m) => m !== representative)
        .sort((a, b) => {
          if (!a.releaseDate && !b.releaseDate) return a.modelName.localeCompare(b.modelName);
          if (!a.releaseDate) return 1;
          if (!b.releaseDate) return -1;
          return b.releaseDate.localeCompare(a.releaseDate);
        });

      representative.variants = others.map((m) => ({
        friendlyId: m.friendlyId,
        modelName: m.modelName,
        displayId: m.displayId,
        releaseDate: m.releaseDate,
      }));

      baseModels.push(representative);
    }

    // Group by provider, sort models within each group by release date (newest first)
    const groups = new Map<string, ModelCatalogItem[]>();
    for (const item of baseModels) {
      const group = groups.get(item.provider) ?? [];
      group.push(item);
      groups.set(item.provider, group);
    }

    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, models]) => ({
        provider,
        models: models.sort((a, b) => {
          if (!a.releaseDate && !b.releaseDate) return a.modelName.localeCompare(b.modelName);
          if (!a.releaseDate) return 1;
          if (!b.releaseDate) return -1;
          return b.releaseDate.localeCompare(a.releaseDate);
        }),
      }));
  }

  /** Get a single model with full pricing details. */
  async getModelDetail(friendlyId: string): Promise<ModelDetail | null> {
    const model = await this._replica.llmModel.findFirst({
      where: { friendlyId },
      include: {
        pricingTiers: {
          include: { prices: true },
          orderBy: { priority: "asc" },
        },
      },
    });

    if (!model) return null;

    const defaultTier = model.pricingTiers.find((t) => t.isDefault) ?? model.pricingTiers[0];
    const defaultPrices = defaultTier?.prices ?? [];
    const inputPrice = defaultPrices.find((p) => p.usageType === "input");
    const outputPrice = defaultPrices.find((p) => p.usageType === "output");
    const provider = model.provider ?? inferProvider(model.modelName);
    const catalogEntry = modelCatalog[model.modelName];

    return {
      friendlyId: model.friendlyId,
      modelName: model.modelName,
      provider,
      displayId: formatModelId(provider, model.modelName),
      description: model.description,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      features: buildFeatures(model.capabilities, catalogEntry),
      inputPrice: inputPrice ? Number(inputPrice.price) : null,
      outputPrice: outputPrice ? Number(outputPrice.price) : null,
      releaseDate: model.startDate ? model.startDate.toISOString().split("T")[0] : null,
      variants: [],
      matchPattern: model.matchPattern,
      source: model.source,
      pricingTiers: model.pricingTiers.map((t) => ({
        name: t.name,
        isDefault: t.isDefault,
        prices: Object.fromEntries(t.prices.map((p) => [p.usageType, Number(p.price)])),
      })),
    };
  }

  /** Get global aggregate metrics for a model (no tenant info). */
  async getGlobalMetrics(
    responseModel: string,
    startTime: Date,
    endTime: Date
  ): Promise<ModelMetricsPoint[]> {
    const [error, rows] = await this.clickhouse.llmModelAggregates.globalMetrics
      .setParams({
        responseModel,
        startTime: formatDateForCH(startTime),
        endTime: formatDateForCH(endTime),
      })
      .execute();

    if (error || !rows) return [];

    return rows.map((r) => ({
      minute: r.minute,
      callCount: r.call_count,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCost: r.total_cost,
      ttfcP50: r.ttfc_p50,
      ttfcP90: r.ttfc_p90,
      ttfcP95: r.ttfc_p95,
      ttfcP99: r.ttfc_p99,
      tpsP50: r.tps_p50,
      tpsP90: r.tps_p90,
      tpsP95: 0,
      tpsP99: 0,
      durationP50: r.duration_p50,
      durationP90: r.duration_p90,
      durationP95: 0,
      durationP99: 0,
    }));
  }

  /** Get per-project usage metrics for a model. */
  async getUserMetrics(
    responseModel: string,
    projectId: string,
    environmentId: string,
    startTime: Date,
    endTime: Date
  ): Promise<UserModelMetrics> {
    const summaryQuery = this.clickhouse.reader.query({
      name: "modelRegistryUserSummary",
      query: `
        SELECT
          count() AS total_calls,
          sum(total_cost) AS total_cost,
          sum(input_tokens) AS total_input_tokens,
          sum(output_tokens) AS total_output_tokens,
          round(avg(ms_to_first_chunk), 1) AS avg_ttfc,
          round(avg(tokens_per_second), 1) AS avg_tps
        FROM trigger_dev.llm_metrics_v1
        WHERE response_model = {responseModel: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND start_time >= {startTime: String}
          AND start_time <= {endTime: String}
      `,
      params: z.object({
        responseModel: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
      }),
      schema: UserMetricsSummaryRow,
    });

    const taskQuery = this.clickhouse.reader.query({
      name: "modelRegistryUserTasks",
      query: `
        SELECT
          task_identifier,
          count() AS calls,
          sum(total_cost) AS cost
        FROM trigger_dev.llm_metrics_v1
        WHERE response_model = {responseModel: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND start_time >= {startTime: String}
          AND start_time <= {endTime: String}
        GROUP BY task_identifier
        ORDER BY cost DESC
        LIMIT 20
      `,
      params: z.object({
        responseModel: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
      }),
      schema: UserTaskBreakdownRow,
    });

    const queryParams = {
      responseModel,
      projectId,
      environmentId,
      startTime: formatDateForCH(startTime),
      endTime: formatDateForCH(endTime),
    };

    const [summaryResult, taskResult] = await Promise.all([
      summaryQuery(queryParams),
      taskQuery(queryParams),
    ]);

    const [summaryError, summaryRows] = summaryResult;
    const [taskError, taskRows] = taskResult;

    const defaultSummary = {
      total_calls: 0,
      total_cost: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      avg_ttfc: 0,
      avg_tps: 0,
    };

    const summary = !summaryError && summaryRows?.[0] ? summaryRows[0] : defaultSummary;

    return {
      totalCalls: summary.total_calls,
      totalCost: summary.total_cost,
      totalInputTokens: summary.total_input_tokens,
      totalOutputTokens: summary.total_output_tokens,
      avgTtfc: summary.avg_ttfc,
      avgTps: summary.avg_tps,
      taskBreakdown: !taskError && taskRows
        ? taskRows.map((r) => ({
            taskIdentifier: r.task_identifier,
            calls: r.calls,
            cost: r.cost,
          }))
        : [],
    };
  }

  /** Get comparison data for 2-4 models. */
  async getModelComparison(
    responseModels: string[],
    startTime: Date,
    endTime: Date
  ): Promise<ModelComparisonItem[]> {
    const [error, rows] = await this.clickhouse.llmModelAggregates.comparison
      .setParams({
        responseModels,
        startTime: formatDateForCH(startTime),
        endTime: formatDateForCH(endTime),
      })
      .execute();

    if (error || !rows) return [];

    return rows.map((r) => ({
      responseModel: r.response_model,
      genAiSystem: r.gen_ai_system,
      callCount: r.call_count,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCost: r.total_cost,
      ttfcP50: r.ttfc_p50,
      ttfcP90: r.ttfc_p90,
      tpsP50: r.tps_p50,
      tpsP90: r.tps_p90,
    }));
  }

  /** Get the most popular models by call count. */
  async getPopularModels(
    startTime: Date,
    endTime: Date,
    limit: number = 20
  ): Promise<PopularModel[]> {
    const [error, rows] = await this.clickhouse.llmModelAggregates.popular
      .setParams({
        startTime: formatDateForCH(startTime),
        endTime: formatDateForCH(endTime),
        limit,
      })
      .execute();

    if (error || !rows) return [];

    return rows.map((r) => ({
      responseModel: r.response_model,
      genAiSystem: r.gen_ai_system,
      callCount: r.call_count,
      totalCost: r.total_cost,
      ttfcP50: r.ttfc_p50,
    }));
  }
}
