import { adminClickhouseClient } from "~/services/clickhouseInstance.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

export type MissingLlmModel = {
  model: string;
  system: string;
  count: number;
};

export async function getMissingLlmModels(opts: {
  lookbackHours?: number;
} = {}): Promise<MissingLlmModel[]> {
  const lookbackHours = opts.lookbackHours ?? 24;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  // queryBuilderFast returns a factory function — call it to get the builder
  const createBuilder = adminClickhouseClient.reader.queryBuilderFast<{
    model: string;
    system: string;
    cnt: string;
  }>({
    name: "missingLlmModels",
    table: "trigger_dev.task_events_v2",
    columns: [
      { name: "model", expression: "attributes.gen_ai.response.model.:String" },
      { name: "system", expression: "attributes.gen_ai.system.:String" },
      { name: "cnt", expression: "count()" },
    ],
  });
  const qb = createBuilder();

  // Partition pruning on inserted_at (partition key is toDate(inserted_at))
  qb.where("inserted_at >= {since: DateTime64(3)}", {
    since: formatDateTime(since),
  });

  // Only spans that have a model set
  qb.where("attributes.gen_ai.response.model.:String != {empty: String}", { empty: "" });

  // Only spans that were NOT cost-enriched (trigger.llm.total_cost is NULL)
  qb.where("attributes.trigger.llm.total_cost.:Float64 IS NULL", {});

  // Only completed spans
  qb.where("kind = {kind: String}", { kind: "SPAN" });
  qb.where("status = {status: String}", { status: "OK" });

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

  if (candidates.length === 0) return [];

  // Filter out models that now have pricing in the database (added after spans were inserted).
  // The registry's match() handles prefix stripping for gateway/openrouter models.
  return candidates.filter((c) => !llmPricingRegistry?.match(c.model));
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
  const lookbackHours = opts.lookbackHours ?? 24;
  const limit = opts.limit ?? 10;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const createBuilder = adminClickhouseClient.reader.queryBuilderFast<MissingModelSample>({
    name: "missingModelSamples",
    table: "trigger_dev.task_events_v2",
    columns: [
      "span_id",
      "run_id",
      "message",
      "attributes_text",
      "duration",
      "start_time",
    ],
  });
  const qb = createBuilder();

  qb.where("inserted_at >= {since: DateTime64(3)}", { since: formatDateTime(since) });
  qb.where("attributes.gen_ai.response.model.:String = {model: String}", { model: opts.model });
  qb.where("attributes.trigger.llm.total_cost.:Float64 IS NULL", {});
  qb.where("kind = {kind: String}", { kind: "SPAN" });
  qb.where("status = {status: String}", { status: "OK" });
  qb.orderBy("start_time DESC");
  qb.limit(limit);

  const [err, rows] = await qb.execute();

  if (err) {
    throw err;
  }

  return rows ?? [];
}

function formatDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
