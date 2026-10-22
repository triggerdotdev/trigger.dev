import { z } from "zod";
import {
  getCapability,
  isScopeAllowed,
  type AlertCapability,
  type AlertParams,
} from "@internal/alert-contracts";
import { $replica, type PrismaClientOrTransaction } from "~/db.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { getMetricSeries } from "~/v3/services/alerts/alertSeries.server";
import { createQueryRowRunner } from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import type { QueryRowRunner } from "~/v3/services/alerts/evaluators/queryEvaluator.server";

const DEFAULT_WINDOW_MINUTES = 720;
export const MAX_WINDOW_MINUTES = 1440;

export const QuerySchema = z.object({
  capabilityKey: z.string().min(1),
  scopeType: z.enum(["queue", "queuePattern", "task", "all"]),
  scopeValue: z.string().optional(),
  windowMinutes: z.coerce.number().positive().optional(),
  threshold: z.coerce.number().finite().optional(),
});

type SeriesPoint = { t: number; v: number | null };
type SeriesOut = { key: string; label: string; points: SeriesPoint[] };
export type PreviewSeriesResponse = {
  series: SeriesOut[];
  threshold?: number;
  unit?: string;
  bucketSec: number;
  windowSec: number;
  generatedAt: string;
};

export interface LoadPreviewSeriesInput {
  userId: string;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  capabilityKey: string;
  scopeType: "queue" | "queuePattern" | "task" | "all";
  scopeValue?: string;
  windowMinutes?: number;
  threshold?: number;
}

export type LoadPreviewSeriesResult =
  | { status: 200; body: PreviewSeriesResponse }
  | { status: 400 | 403 | 404; body: { error: string } };

function buildScope(
  scopeType: LoadPreviewSeriesInput["scopeType"],
  scopeValue: string | undefined
): AlertParams["scope"] | null {
  switch (scopeType) {
    case "queue":
      return scopeValue ? { type: "queue", queue: scopeValue } : null;
    case "queuePattern":
      return scopeValue ? { type: "queuePattern", pattern: scopeValue } : null;
    case "task":
      return scopeValue ? { type: "task", taskIdentifier: scopeValue } : null;
    case "all":
      return { type: "all" };
  }
}

async function seriesForCapability(
  capability: AlertCapability,
  params: AlertParams,
  organizationId: string,
  projectId: string,
  windowHours: number,
  runner: QueryRowRunner,
  cacheKeyPrefix: string
): Promise<SeriesOut[]> {
  const metricMap = await getMetricSeries(
    {
      alertId: `${cacheKeyPrefix}:${capability.key}`,
      capability,
      params,
      organizationId,
      projectId,
      windowHours,
    },
    runner
  );

  const out: SeriesOut[] = [];
  for (const [key, points] of metricMap) {
    const label = key === "__agg__" ? capability.title : key === "__other__" ? "Other" : key;
    out.push({ key, label, points: points.map((p) => ({ t: p.bucket, v: p.value })) });
  }
  return out;
}

export async function loadPreviewSeries(
  input: LoadPreviewSeriesInput,
  deps: { runner?: QueryRowRunner; db?: PrismaClientOrTransaction } = {}
): Promise<LoadPreviewSeriesResult> {
  const capability = getCapability(input.capabilityKey);
  if (!capability) {
    return { status: 400, body: { error: "Unknown capability" } };
  }
  if (!isScopeAllowed(capability, input.scopeType)) {
    return { status: 400, body: { error: "Scope not allowed for this capability" } };
  }
  const scope = buildScope(input.scopeType, input.scopeValue);
  if (!scope) {
    return { status: 400, body: { error: "Missing scope value" } };
  }

  const db = deps.db ?? $replica;

  const project = await findProjectWithOrgFlagsBySlug(
    input.organizationSlug,
    input.projectParam,
    input.userId,
    db
  );
  if (!project) {
    return { status: 404, body: { error: "Project not found" } };
  }

  const environment = await findEnvironmentBySlug(project.id, input.envParam, input.userId, db);
  if (!environment) {
    return { status: 404, body: { error: "Environment not found" } };
  }

  const dbUser = await db.user.findFirst({ where: { id: input.userId }, select: { admin: true } });

  const alertsEnabled = await canUseAlertsList({
    orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    user: { admin: dbUser?.admin ?? false },
  });
  if (!alertsEnabled) {
    return { status: 403, body: { error: "Alerts not enabled" } };
  }

  const windowMinutes = Math.min(input.windowMinutes ?? DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES);
  const windowHours = windowMinutes / 60;

  const params: AlertParams = { environmentId: environment.id, scope };
  const runner = deps.runner ?? createQueryRowRunner(1);
  const cacheKeyPrefix = `preview:${environment.id}:${input.scopeType}:${input.scopeValue ?? ""}:${windowMinutes}`;

  const subKeys = capability.binding.compositeOf;
  let series: SeriesOut[] = [];
  if (subKeys && subKeys.length > 0) {
    for (const subKey of subKeys) {
      const subCapability = getCapability(subKey);
      if (!subCapability) continue;
      const subSeries = await seriesForCapability(
        subCapability,
        params,
        project.organizationId,
        project.id,
        windowHours,
        runner,
        cacheKeyPrefix
      );
      series.push(
        ...subSeries.map((s) => ({
          ...s,
          key: `${subKey}:${s.key}`,
          label: subCapability.title,
        }))
      );
    }
  } else {
    series = await seriesForCapability(
      capability,
      params,
      project.organizationId,
      project.id,
      windowHours,
      runner,
      cacheKeyPrefix
    );
  }

  return {
    status: 200,
    body: {
      series,
      threshold: input.threshold,
      unit: subKeys && subKeys.length > 0 ? undefined : capability.unit,
      bucketSec: capability.binding.minCadenceSec,
      windowSec: windowMinutes * 60,
      generatedAt: new Date().toISOString(),
    },
  };
}
