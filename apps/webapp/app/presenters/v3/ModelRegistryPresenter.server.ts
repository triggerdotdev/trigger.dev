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

/**
 * Hardcoded provider display priority (most relevant first). Providers not in
 * this list fall back to alphabetical order after the listed ones. Within a
 * provider, models are always sorted by release date (newest first).
 */
const PROVIDER_IMPORTANCE = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "meta",
  "mistral",
  "deepseek",
];

function providerRank(provider: string): number {
  const index = PROVIDER_IMPORTANCE.indexOf(provider);
  return index === -1 ? PROVIDER_IMPORTANCE.length : index;
}

/**
 * Pick a sparkline bucket size (in seconds) for a given range so the rendered
 * sparkline stays a readable ~24-52 bars. Tuned for the small inline charts in
 * the "Your models" list — coarser than the full-size dashboard charts.
 */
function sparklineBucketSeconds(rangeMs: number): number {
  const MIN = 60;
  const HOUR = 3600;
  const DAY = 86400;
  const ms = (s: number) => s * 1000;
  if (rangeMs <= ms(HOUR)) return 2 * MIN;
  if (rangeMs <= ms(3 * HOUR)) return 5 * MIN;
  if (rangeMs <= ms(6 * HOUR)) return 15 * MIN;
  if (rangeMs <= ms(DAY)) return HOUR;
  if (rangeMs <= ms(3 * DAY)) return 2 * HOUR;
  if (rangeMs <= ms(7 * DAY)) return 6 * HOUR;
  if (rangeMs <= ms(14 * DAY)) return 12 * HOUR;
  if (rangeMs <= ms(30 * DAY)) return DAY;
  if (rangeMs <= ms(90 * DAY)) return 3 * DAY;
  return 7 * DAY;
}

/**
 * Generate the ordered bucket-start keys for [from, to] at the given interval,
 * as epoch seconds to match ClickHouse's
 * `toUnixTimestamp(toStartOfInterval(col, INTERVAL n SECOND))` — timezone-independent
 * (a raw DateTime string would depend on the ClickHouse server timezone).
 */
function sparklineBucketKeys(from: Date, to: Date, intervalSeconds: number): number[] {
  const intervalMs = intervalSeconds * 1000;
  const start = Math.floor(from.getTime() / intervalMs) * intervalMs;
  const end = Math.floor(to.getTime() / intervalMs) * intervalMs;
  const keys: number[] = [];
  for (let t = start; t <= end; t += intervalMs) {
    keys.push(t / 1000);
  }
  return keys;
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

/** A model with usage in a specific project/environment (the "Your models" list). */
export type ProjectModelUsageItem = {
  responseModel: string;
  genAiSystem: string;
  calls: number;
  totalCost: number;
  totalTokens: number;
  avgTtfc: number;
  avgTps: number;
  /** Input tokens (used as the denominator for the cache read rate). */
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedReadTokens: number;
  /** Actual (discounted) cost of those cached read tokens. */
  cachedReadCost: number;
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

const ProjectModelUsageRow = z.object({
  response_model: z.string(),
  gen_ai_system: z.string(),
  calls: z.coerce.number(),
  total_cost: z.coerce.number(),
  total_tokens: z.coerce.number(),
  avg_ttfc: z.coerce.number(),
  avg_tps: z.coerce.number(),
  input_tokens: z.coerce.number(),
  cached_read_tokens: z.coerce.number(),
  cached_read_cost: z.coerce.number(),
});

const ModelSparklineRow = z.object({
  response_model: z.string(),
  bucket: z.coerce.number(),
  val: z.coerce.number(),
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
      .sort(([a], [b]) => {
        const rankA = providerRank(a);
        const rankB = providerRank(b);
        if (rankA !== rankB) return rankA - rankB;
        return a.localeCompare(b);
      })
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

  /**
   * Models that had usage in a specific project/environment over the window,
   * with aggregate metrics. This is the tenant-scoped "Your models" list (as
   * opposed to the cross-tenant getPopularModels).
   */
  async getProjectModelUsage(
    projectId: string,
    environmentId: string,
    startTime: Date,
    endTime: Date
  ): Promise<ProjectModelUsageItem[]> {
    const queryFn = this.clickhouse.reader.query({
      name: "modelRegistryProjectUsage",
      query: `
        SELECT
          response_model,
          any(gen_ai_system) AS gen_ai_system,
          count() AS calls,
          sum(total_cost) AS total_cost,
          sum(total_tokens) AS total_tokens,
          round(avg(ms_to_first_chunk), 1) AS avg_ttfc,
          round(avg(tokens_per_second), 1) AS avg_tps,
          sum(input_tokens) AS input_tokens,
          sum(usage_details['input_cached_tokens']) AS cached_read_tokens,
          sum(cost_details['input_cached_tokens']) AS cached_read_cost
        FROM trigger_dev.llm_metrics_v1
        WHERE project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND start_time >= {startTime: String}
          AND start_time <= {endTime: String}
          AND response_model != ''
        GROUP BY response_model
        ORDER BY calls DESC
        LIMIT 100
      `,
      params: z.object({
        projectId: z.string(),
        environmentId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
      }),
      schema: ProjectModelUsageRow,
    });

    const [error, rows] = await queryFn({
      projectId,
      environmentId,
      startTime: formatDateForCH(startTime),
      endTime: formatDateForCH(endTime),
    });

    if (error || !rows) return [];

    return rows.map((r) => ({
      responseModel: r.response_model,
      genAiSystem: r.gen_ai_system,
      calls: r.calls,
      totalCost: r.total_cost,
      totalTokens: r.total_tokens,
      avgTtfc: r.avg_ttfc,
      avgTps: r.avg_tps,
      inputTokens: r.input_tokens,
      cachedReadTokens: r.cached_read_tokens,
      cachedReadCost: r.cached_read_cost,
    }));
  }

  /**
   * Call-count and total-token sparklines per response_model over [from, to],
   * matching the window the "Your models" charts and table use. The bucket size
   * adapts to the range (see sparklineBucketSeconds) so a sparkline stays a
   * readable ~24-52 bars regardless of the selected period. Zero-filled.
   */
  async getModelUsageSparklines(
    projectId: string,
    environmentId: string,
    responseModels: string[],
    from: Date,
    to: Date
  ): Promise<{
    calls: Record<string, number[]>;
    tokens: Record<string, number[]>;
    bucketIntervalMs: number;
    bucketStartMs: number;
  }> {
    const intervalSeconds = sparklineBucketSeconds(to.getTime() - from.getTime());
    const intervalMs = intervalSeconds * 1000;
    // Epoch-aligned start of the first bucket, matching sparklineBucketKeys and
    // ClickHouse toStartOfInterval. Returned so the sparkline tooltip can label
    // each bar with its true time rather than assuming hourly buckets.
    const bucketStartMs = Math.floor(from.getTime() / intervalMs) * intervalMs;

    if (responseModels.length === 0) {
      return { calls: {}, tokens: {}, bucketIntervalMs: intervalMs, bucketStartMs };
    }

    const bucketKeys = sparklineBucketKeys(from, to, intervalSeconds);

    // intervalSeconds is a server-derived integer from a fixed ladder, so it's
    // safe to inline. Epoch-aligned SECOND buckets match the JS keys above.
    const buildQuery = (valueExpr: string, name: string) =>
      this.clickhouse.reader.query({
        name,
        query: `
          SELECT
            response_model,
            toUnixTimestamp(toStartOfInterval(start_time, INTERVAL ${intervalSeconds} SECOND)) AS bucket,
            ${valueExpr} AS val
          FROM trigger_dev.llm_metrics_v1
          WHERE project_id = {projectId: String}
            AND environment_id = {environmentId: String}
            AND response_model IN {responseModels: Array(String)}
            AND start_time >= {startTime: String}
            AND start_time <= {endTime: String}
          GROUP BY response_model, bucket
          ORDER BY response_model, bucket
        `,
        params: z.object({
          projectId: z.string(),
          environmentId: z.string(),
          responseModels: z.array(z.string()),
          startTime: z.string(),
          endTime: z.string(),
        }),
        schema: ModelSparklineRow,
      });

    const queryParams = {
      projectId,
      environmentId,
      responseModels,
      startTime: formatDateForCH(from),
      endTime: formatDateForCH(to),
    };

    const [callsResult, tokensResult] = await Promise.all([
      buildQuery("count()", "modelCallSparklines")(queryParams),
      buildQuery("sum(total_tokens)", "modelTokenSparklines")(queryParams),
    ]);

    return {
      calls: this.#buildSparklineMap(callsResult, responseModels, bucketKeys),
      tokens: this.#buildSparklineMap(tokensResult, responseModels, bucketKeys),
      bucketIntervalMs: intervalMs,
      bucketStartMs,
    };
  }

  /** Convert a sparkline query result to a zero-filled bucket map. */
  #buildSparklineMap(
    queryResult:
      | [Error, null]
      | [null, { response_model: string; bucket: number; val: number }[]],
    keys: string[],
    bucketKeys: number[]
  ): Record<string, number[]> {
    const [error, rows] = queryResult;
    if (error || !rows) return {};

    const rowMap = new Map<string, number>();
    for (const row of rows) {
      rowMap.set(`${row.response_model}|${row.bucket}`, row.val);
    }

    const result: Record<string, number[]> = {};
    for (const key of keys) {
      result[key] = bucketKeys.map((b) => rowMap.get(`${key}|${b}`) ?? 0);
    }
    return result;
  }
}
