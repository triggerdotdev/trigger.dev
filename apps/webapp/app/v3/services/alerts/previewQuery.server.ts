import { getCapability, type Condition } from "@internal/alert-contracts";
import { z } from "zod";
import { env } from "~/env.server";
import { querySchemas } from "~/v3/querySchemas";
import { createQueryRowRunner } from "./engine/productionEvaluateBinding.server";
import {
  clickhouseDateTimeLiteral,
  evaluateQueryCapability,
  forwardUntil,
  OFFENDER_DETAIL_ROWS,
  type QueryRowRunner,
} from "./evaluators/queryEvaluator.server";
import {
  analyzeQueryForAlert,
  queryWindowIssue,
  toQuerySignal,
} from "./queryAlerts/analyzeQueryForAlert.server";
import {
  buildQueryCapability,
  CUSTOM_QUERY_CAPABILITY,
} from "./queryAlerts/resolveAlertCapability.server";

const MAX_QUERY_LENGTH = 8192;
const MAX_PREVIEW_WINDOW_MINUTES = 1440;
const EXTRA_COLUMNS = 3;

export const PreviewQuerySchema = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_LENGTH),
    mode: z.enum(["threshold", "absence", "match"]),
    measure: z.string().min(1).optional(),
    windowMinutes: z.number().int().positive().max(MAX_PREVIEW_WINDOW_MINUTES),
    threshold: z.number().finite().optional(),
    operator: z.enum([">", "<"]).optional(),
  })
  .refine(
    (v) => v.mode !== "threshold" || (v.threshold !== undefined && v.operator !== undefined),
    { message: "threshold and operator are required for threshold alerts" }
  );
export type PreviewQueryInput = z.infer<typeof PreviewQuerySchema>;

export type PreviewQueryResponse =
  | {
      ok: true;
      mode: PreviewQueryInput["mode"];
      value?: number | null;
      offenders?: Array<{ key: string; value: number }>;
      rows?: Array<{ id: string; time: string; columns: Record<string, unknown> }>;
      total?: number;
      capped?: boolean;
      wouldFire: boolean;
      window: { minutes: number; from: string; to: string };
    }
  | { ok: false; reason: string };

export type PreviewQueryTenant = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

function rejected(reason: string): PreviewQueryResponse {
  return { ok: false, reason };
}

function rowTimeIso(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export async function previewQueryAlert(
  input: PreviewQueryInput,
  tenant: PreviewQueryTenant,
  deps: { runner?: QueryRowRunner; now?: () => Date } = {}
): Promise<PreviewQueryResponse> {
  const analysis = analyzeQueryForAlert(input.query, {
    tableSchemas: querySchemas,
    flags: { QUEUE_METRICS: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1" },
  });
  if (!analysis.ok) {
    const issues = analysis.errors.length
      ? analysis.errors
      : analysis.unsupported.filter((u) => u.mode === input.mode);
    const reason = issues.map((i) => i.message).join(" ");
    return rejected(reason || "The query can't be used for an alert.");
  }

  const choice = toQuerySignal(analysis, { mode: input.mode, measure: input.measure });
  if (!choice.ok) return rejected(choice.message);
  const signal = choice.signal;

  const base = getCapability(CUSTOM_QUERY_CAPABILITY);
  if (!base) return rejected("Query alerts are unavailable.");
  const resolved = buildQueryCapability(input.query, signal, analysis, base);
  if (resolved.unavailable) return rejected(resolved.unavailable.reason);
  const { capability } = resolved;

  const windowSec = input.windowMinutes * 60;
  if (input.mode !== "match") {
    const windowIssue = queryWindowIssue(analysis, windowSec);
    if (windowIssue) return rejected(windowIssue);
  }

  const now = (deps.now ?? (() => new Date()))();
  const runner = deps.runner ?? createQueryRowRunner(undefined, { userAuthoredQuery: true });
  const evaluation = {
    capabilityKey: CUSTOM_QUERY_CAPABILITY,
    params: {
      environmentId: tenant.environmentId,
      scope: { type: "all" as const },
      querySignal: signal,
    },
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    now,
    capability,
  };

  if (input.mode === "match") {
    const until = forwardUntil(now);
    const checkpoint = new Date(until.getTime() - windowSec * 1000);
    const result = await evaluateQueryCapability(
      {
        ...evaluation,
        condition: { kind: "occurrence" },
        matchWindow: { from: checkpoint, to: until },
        ctx: {
          checkpoint: clickhouseDateTimeLiteral(checkpoint),
          until: clickhouseDateTimeLiteral(until),
          after: "1 = 1",
        },
      },
      runner
    );
    if (result.kind !== "occurrence") return rejected("Unexpected evaluation result.");

    const rowKey = capability.binding.rowKey ?? [];
    const timeColumn = capability.binding.rowTimeColumn;
    const skip = new Set([...rowKey, timeColumn]);
    const rows = result.occurrences.slice(0, OFFENDER_DETAIL_ROWS).map((o) => ({
      id: rowKey.map((col) => String(o.facts[col])).join(":"),
      time: rowTimeIso(timeColumn ? o.facts[timeColumn] : undefined),
      columns: Object.fromEntries(
        Object.entries(o.facts)
          .filter(([col]) => !skip.has(col))
          .slice(0, EXTRA_COLUMNS)
      ),
    }));
    return {
      ok: true,
      mode: "match",
      rows,
      total: result.occurrences.length,
      capped: result.facts.capped === true,
      wouldFire: result.outcome === "met",
      window: {
        minutes: input.windowMinutes,
        from: checkpoint.toISOString(),
        to: until.toISOString(),
      },
    };
  }

  const condition: Condition =
    input.mode === "absence"
      ? { kind: "absence", quietWindowSec: windowSec }
      : { kind: "threshold", operator: input.operator!, value: input.threshold!, windowSec };
  const result = await evaluateQueryCapability({ ...evaluation, condition }, runner);
  if (result.kind !== "stateful") return rejected("Unexpected evaluation result.");
  if (result.outcome === "unavailable") {
    const reason = result.facts.unavailableReason;
    return rejected(
      reason === "too_many_groups"
        ? "The query returns too many groups to alert on."
        : String(reason ?? "The query could not be evaluated.")
    );
  }

  const offenders = Array.isArray(result.facts.offenders)
    ? (result.facts.offenders as Array<{ key: string; value: number }>).map((o) => ({
        key: o.key,
        value: o.value,
      }))
    : undefined;
  return {
    ok: true,
    mode: input.mode,
    value: result.facts.value as number | null,
    ...(offenders ? { offenders } : {}),
    wouldFire: result.outcome === "met",
    window: {
      minutes: input.windowMinutes,
      from: new Date(now.getTime() - windowSec * 1000).toISOString(),
      to: now.toISOString(),
    },
  };
}
