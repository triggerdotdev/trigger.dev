import { logger } from "@trigger.dev/sdk";

/**
 * The data-handling policy for the per-turn eval: how many turns are judged, what a
 * judged turn may carry, which turns are never judged, and which orgs opt out.
 *
 * This is the one place the rules live. A judged turn writes a `chat_turn_evals` row and
 * sends the turn to an LLM judge, so every rule here exists to keep customer content out
 * of both. Nothing plan- or entitlement-related belongs here — this is not a paid feature.
 */

/**
 * Fraction of production turns to judge, from `DASHBOARD_AGENT_EVAL_SAMPLE_RATE`. Read per
 * turn so the rate can change without a redeploy.
 *
 * The judge is a full model call per turn, and nothing reads `chat_turn_evals` yet, so the
 * default samples a tenth — including when the value is unparseable, where a fallback of 1
 * would quietly turn a typo into full-rate billing.
 */
export const DEFAULT_EVAL_SAMPLE_RATE = 0.1;

/** Golden / CI runs judge every turn: a sampled suite would flake and prove nothing. */
export const DEFAULT_CI_EVAL_SAMPLE_RATE = 1;

/** Set to "ci" by the golden harness only. Nothing else selects the CI lane. */
export const EVAL_CONTEXT_ENV = "DASHBOARD_AGENT_EVAL_CONTEXT";

/**
 * The two lanes read different variables, so a CI run can neither read nor change the
 * production rate — and a production value can't quietly de-sample the golden suite.
 */
const PRODUCTION_RATE_ENV = "DASHBOARD_AGENT_EVAL_SAMPLE_RATE";
const CI_RATE_ENV = "DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI";

export function isCiEvalContext(): boolean {
  return process.env[EVAL_CONTEXT_ENV] === "ci";
}

function parseRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export function evalSampleRate(): number {
  return isCiEvalContext()
    ? parseRate(process.env[CI_RATE_ENV], DEFAULT_CI_EVAL_SAMPLE_RATE)
    : parseRate(process.env[PRODUCTION_RATE_ENV], DEFAULT_EVAL_SAMPLE_RATE);
}

// `Math.random()` is in [0, 1), so rate 0 never samples and rate 1 always does.
export function shouldEvalTurn(): boolean {
  return Math.random() < evalSampleRate();
}

/**
 * The code-mode source tools. A turn that read source is never judged at all: the judge
 * would have to be handed the customer's code to check the answer against it, and a
 * source-free judgement of a source-grounded answer is not worth the row.
 */
export const SOURCE_TOOLS = ["read_file", "search_code", "list_files", "get_repo_info"];

export function turnReadSource(toolActivity: Array<{ toolName: string }>): boolean {
  return toolActivity.some((activity) => SOURCE_TOOLS.includes(activity.toolName));
}

/**
 * The fields a judged turn may carry, by name. An allow-list rather than a deny-list:
 * a tool result is arbitrary JSON, so any name we didn't think of can hold the
 * customer's own text — a payload field renamed, a free-text column in a query row,
 * an error string that quotes the record it failed on. Naming what may pass fails
 * closed; naming what may not fails open on every field added after this list.
 *
 * What the judge grades on is narrow: did the answer use the ids, statuses, names,
 * counts and timestamps the tools returned. Everything else reaches it as a shape
 * descriptor, which `JUDGE_SYSTEM` tells it to read as retrieved-but-unreadable.
 */
const STRUCTURAL_KEYS = new Set([
  // Containers the walk descends into.
  "alerts",
  "data",
  "deploys",
  "environments",
  "errors",
  "error",
  "items",
  "projects",
  "queues",
  "results",
  "runs",
  "schedules",
  "tasks",
  "watches",
  // Identity.
  "batchId",
  "deployId",
  "environmentId",
  "id",
  "ids",
  "organizationId",
  "projectId",
  "projectRef",
  "queueId",
  "runId",
  "scheduleId",
  "spanId",
  "taskId",
  "taskIdentifier",
  "traceId",
  "watchId",
  "friendlyId",
  // Names and kinds — a task, queue, error class or environment name is a fact.
  "environment",
  "kind",
  "name",
  "slug",
  "type",
  "queue",
  "machine",
  "region",
  "runtime",
  // State.
  "isError",
  "level",
  "outcome",
  "state",
  "status",
  "statuses",
  "verdict",
  // Shape and size.
  "attempts",
  "attemptCount",
  "count",
  "cursor",
  "hasMore",
  "limit",
  "page",
  "rowCount",
  "total",
  "totalCount",
  // Time.
  "completedAt",
  "createdAt",
  "durationMs",
  "expiresAt",
  "finishedAt",
  "from",
  "startedAt",
  "timestamp",
  "to",
  "updatedAt",
  "window",
  // Versions.
  "cliVersion",
  "sdkVersion",
  "version",
  // Markers this module and the truncation step add themselves.
  "chars",
  "keys",
  "note",
  "omitted",
  "redacted",
  "truncated",
]);

/**
 * Fields that are structural for one tool only. Kept per tool rather than added to the
 * shared list, so a column name that is a fact for `run_query` doesn't become one
 * everywhere.
 */
const TOOL_STRUCTURAL_KEYS: Record<string, readonly string[]> = {
  run_query: ["columns"],
  get_query_schema: ["columns", "tables", "table", "column"],
  get_report: ["sections", "section", "title", "metric", "metrics"],
  list_alerts: ["channel", "enabled"],
  get_queue: ["concurrencyLimit", "paused"],
  correlate_version: ["versions", "before", "after"],
};

/** The keys a given tool's activity may carry. */
export function allowedEvalKeys(toolName?: string): ReadonlySet<string> {
  const extras = toolName ? TOOL_STRUCTURAL_KEYS[toolName] : undefined;
  if (!extras) return STRUCTURAL_KEYS;
  return new Set([...STRUCTURAL_KEYS, ...extras]);
}

/** Max keys listed in a shape descriptor, so a wide object can't grow the prompt. */
const MAX_SHAPE_KEYS = 20;

function describeShape(key: string, value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { redacted: key, items: value.length };
  if (typeof value === "string") return { redacted: key, chars: value.length };
  if (value !== null && typeof value === "object") {
    return { redacted: key, keys: Object.keys(value).slice(0, MAX_SHAPE_KEYS) };
  }
  return { redacted: key };
}

/** Depth cap: a deep tool result can't be walked forever. */
const MAX_REDACT_DEPTH = 8;

/**
 * What a value becomes at the depth cap. The walk stops here, so it cannot know whether
 * anything below is sensitive — passing the value on would leak exactly what it can no
 * longer inspect.
 */
function describeTruncated(value: object): Record<string, unknown> {
  return Array.isArray(value)
    ? { truncated: true, items: value.length }
    : { truncated: true, keys: Object.keys(value).slice(0, MAX_SHAPE_KEYS) };
}

/**
 * Keep the allowed structural fields, at any depth, and replace everything else with its
 * shape. Not a scrub of stored text: the value never reaches the judge or the row in the
 * first place.
 *
 * Pass the tool's name so its own structural fields are allowed too.
 */
export function redactEvalToolValue(value: unknown, toolName?: string, depth = 0): unknown {
  const allowed = allowedEvalKeys(toolName);
  return walk(value, allowed, depth);
}

function walk(value: unknown, allowed: ReadonlySet<string>, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return describeTruncated(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, allowed, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = allowed.has(key) ? walk(item, allowed, depth + 1) : describeShape(key, item);
  }
  return result;
}

/** True when the value the fetch returned says this org's turns may be judged. */
function parseTurnEvalsEnabled(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { turnEvalsEnabled?: unknown }).turnEvalsEnabled === true
  );
}

const POLICY_TIMEOUT_MS = 5_000;

/**
 * Whether this org's turns may be judged, per its `dashboardAgentTurnEvalsEnabled` feature
 * flag. The agent can't read the flag table (it has no main-database access), so it asks
 * the API as the user.
 *
 * Fails closed on everything: no token, no origin, a non-200, an unparseable body, a
 * timeout. A judged turn sends the user's question and the agent's answer to a third-party
 * model, so an unknown answer must never be read as consent.
 */
export async function orgAllowsTurnEvals(params: {
  apiOrigin?: string;
  userActorToken?: string;
  organizationId: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { apiOrigin, userActorToken, organizationId } = params;
  if (!apiOrigin || !userActorToken) {
    logger.warn("dashboard-agent turn eval skipped: no way to read the org's eval setting");
    return false;
  }

  const url = `${apiOrigin.replace(/\/$/, "")}/api/v1/dashboard-agent/eval-policy?organizationId=${encodeURIComponent(organizationId)}`;

  try {
    const response = await (params.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${userActorToken}` },
      signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("dashboard-agent turn eval skipped: the org's eval setting couldn't be read", {
        status: response.status,
      });
      return false;
    }
    return parseTurnEvalsEnabled(await response.json());
  } catch (error) {
    logger.warn("dashboard-agent turn eval skipped: the org's eval setting couldn't be read", {
      error,
    });
    return false;
  }
}
