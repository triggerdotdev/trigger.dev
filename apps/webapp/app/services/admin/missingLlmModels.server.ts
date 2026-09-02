import { LRUCache } from "lru-cache";
import { trail } from "agentcrumbs"; // @crumbs
import { getAdminClickhouse } from "~/services/clickhouse/clickhouseFactory.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

const crumb = trail("webapp"); // @crumbs

const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 30 * 24;
const MISSING_LLM_MODELS_CACHE_TTL_MS = 60_000;
const MISSING_LLM_QUERY_SETTINGS = {
  // Stop server-side before the ClickHouse client's default 30-second request timeout.
  max_execution_time: 25,
  max_memory_usage: String(512 * 1024 * 1024),
  max_threads: 2,
};

export type MissingLlmModel = {
  model: string;
  system: string;
  count: number;
};

const missingLlmModelsCache = new LRUCache<number, Promise<MissingLlmModel[]>>({
  max: 16,
  ttl: MISSING_LLM_MODELS_CACHE_TTL_MS,
});

export async function getMissingLlmModels(
  opts: {
    lookbackHours?: number;
  } = {}
): Promise<MissingLlmModel[]> {
  const lookbackHours = validateLookbackHours(opts.lookbackHours);
  let candidatesPromise = missingLlmModelsCache.get(lookbackHours);

  if (candidatesPromise) {
    crumb("missing LLM models cache hit", { lookbackHours }); // @crumbs
  } else {
    crumb("missing LLM models cache miss", { lookbackHours }); // @crumbs
    candidatesPromise = queryMissingLlmModels(lookbackHours);
    missingLlmModelsCache.set(lookbackHours, candidatesPromise);
  }

  let candidates: MissingLlmModel[];
  try {
    candidates = await candidatesPromise;
  } catch (error) {
    if (missingLlmModelsCache.get(lookbackHours) === candidatesPromise) {
      missingLlmModelsCache.delete(lookbackHours);
    }
    throw error;
  }

  // Filter out models that now have pricing in the database (added after spans were inserted).
  // The registry's match() handles prefix stripping for gateway/openrouter models.
  if (!llmPricingRegistry || !llmPricingRegistry.isLoaded) return candidates;
  const registry = llmPricingRegistry;
  return candidates.filter((c) => !registry.match(c.model));
}

async function queryMissingLlmModels(lookbackHours: number): Promise<MissingLlmModel[]> {
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const adminClickhouse = getAdminClickhouse();

  // queryBuilderFast returns a factory function — call it to get the builder
  const createBuilder = adminClickhouse.reader.queryBuilderFast<{
    model: string;
    system: string;
    cnt: string;
  }>({
    name: "missingLlmModels",
    table: "trigger_dev.task_events_v2",
    columns: [
      {
        name: "model",
        expression: "JSONExtractString(attributes_text, 'gen_ai', 'response', 'model')",
      },
      {
        name: "system",
        expression: "JSONExtractString(attributes_text, 'gen_ai', 'system')",
      },
      { name: "cnt", expression: "count()" },
    ],
    settings: MISSING_LLM_QUERY_SETTINGS,
  });
  const qb = createBuilder();

  // Read narrow filter columns before materializing and parsing attributes_text.
  qb.prewhere("inserted_at >= {since: DateTime64(3)}", { since: formatDateTime(since) });
  qb.prewhere("kind = {kind: String}", { kind: "SPAN" });
  qb.prewhere("status = {status: String}", { status: "OK" });

  // Only spans that have a model set
  qb.where("JSONExtractString(attributes_text, 'gen_ai', 'response', 'model') != {empty: String}", {
    empty: "",
  });

  // Only spans that were NOT cost-enriched (trigger.llm.total_cost is NULL)
  qb.where(
    "JSONExtract(attributes_text, 'trigger', 'llm', 'total_cost', 'Nullable(Float64)') IS NULL",
    {}
  );

  qb.groupBy("model, system");
  qb.orderBy("cnt DESC");
  qb.limit(100);

  const [err, rows] = await qb.execute();

  if (err) {
    throw err;
  }

  if (!rows) {
    return [];
  }

  const candidates = rows
    .filter((r) => r.model)
    .map((r) => ({
      model: r.model,
      system: r.system,
      count: parseInt(r.cnt, 10),
    }));

  crumb("missing LLM models query complete", { lookbackHours, candidates: candidates.length }); // @crumbs
  return candidates;
}

export type MissingModelSample = {
  span_id: string;
  run_id: string;
  message: string;
  attributes_text: string;
  duration: string;
  start_time: string;
};

export async function getMissingModelSamples(opts: {
  model: string;
  lookbackHours?: number;
  limit?: number;
}): Promise<MissingModelSample[]> {
  const lookbackHours = validateLookbackHours(opts.lookbackHours);
  const limit = opts.limit ?? 10;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const adminClickhouse = getAdminClickhouse();

  const createBuilder = adminClickhouse.reader.queryBuilderFast<MissingModelSample>({
    name: "missingModelSamples",
    table: "trigger_dev.task_events_v2",
    columns: ["span_id", "run_id", "message", "attributes_text", "duration", "start_time"],
    settings: MISSING_LLM_QUERY_SETTINGS,
  });
  const qb = createBuilder();

  // Read narrow filter columns before materializing and parsing attributes_text.
  qb.prewhere("inserted_at >= {since: DateTime64(3)}", { since: formatDateTime(since) });
  qb.prewhere("kind = {kind: String}", { kind: "SPAN" });
  qb.prewhere("status = {status: String}", { status: "OK" });
  qb.where("JSONExtractString(attributes_text, 'gen_ai', 'response', 'model') = {model: String}", {
    model: opts.model,
  });
  qb.where(
    "JSONExtract(attributes_text, 'trigger', 'llm', 'total_cost', 'Nullable(Float64)') IS NULL",
    {}
  );
  qb.orderBy("start_time DESC");
  qb.limit(limit);

  const [err, rows] = await qb.execute();

  if (err) {
    throw err;
  }

  return rows ?? [];
}

function validateLookbackHours(lookbackHours = DEFAULT_LOOKBACK_HOURS): number {
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > MAX_LOOKBACK_HOURS) {
    throw new RangeError(`lookbackHours must be between 1 and ${MAX_LOOKBACK_HOURS}`);
  }

  return lookbackHours;
}

function formatDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
