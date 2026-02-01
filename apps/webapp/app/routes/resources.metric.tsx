import { useFetcher } from "@remix-run/react";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Label } from "~/components/primitives/Label";
import { Spinner } from "~/components/primitives/Spinner";
import { requireUserId } from "~/services/session.server";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { executeQuery } from "~/services/queryService.server";
import { QueryWidget, QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { useInterval } from "~/hooks/useInterval";

const Scope = z.union([z.literal("environment"), z.literal("organization"), z.literal("project")]);

const MetricWidgetQuery = z.object({
  query: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  scope: Scope,
  period: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  taskIdentifiers: z.array(z.string()).optional(),
  queues: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);

  const data = await request.json();
  const submission = MetricWidgetQuery.safeParse(data);

  if (!submission.success) {
    return json(
      {
        success: false as const,
        error: "Invalid input",
      },
      { status: 400 }
    );
  }

  const {
    query,
    organizationId,
    projectId,
    environmentId,
    scope,
    period,
    from,
    to,
    taskIdentifiers,
    queues,
    tags,
  } = submission.data;

  // Check they should be able to access it
  const hasAccess = await hasAccessToEnvironment({
    environmentId,
    projectId,
    organizationId,
    userId,
  });

  if (!hasAccess) {
    return json(
      {
        success: false as const,
        error: "You don't have permission for this resource",
      },
      { status: 400 }
    );
  }

  const queryResult = await executeQuery({
    name: "query-page",
    query,
    scope,
    organizationId,
    projectId,
    environmentId,
    period,
    from,
    to,
    // Set higher concurrency if many widgets are on screen at once
    customOrgConcurrencyLimit: 15,
  });

  if (!queryResult.success) {
    return json(
      {
        success: false as const,
        error: queryResult.error.message,
      },
      { status: 400 }
    );
  }

  return json({
    success: true as const,
    data: {
      rows: queryResult.result.rows,
      columns: queryResult.result.columns,
      stats: queryResult.result.stats,
      hiddenColumns: queryResult.result.hiddenColumns ?? null,
      reachedMaxRows: queryResult.result.reachedMaxRows,
      periodClipped: queryResult.periodClipped,
      maxQueryPeriod: queryResult.maxQueryPeriod,
    },
  });
};

type MetricWidgetProps = {
  title: string;
  config: QueryWidgetConfig;
  refreshIntervalMs?: number;
} & z.infer<typeof MetricWidgetQuery>;

export function MetricWidget({ title, config, refreshIntervalMs, ...props }: MetricWidgetProps) {
  const fetcher = useFetcher<typeof action>();
  const isLoading = fetcher.state !== "idle";

  const submit = useCallback(async () => {
    fetcher.submit(props, {
      method: "POST",
      action: `/resources/metric`,
      encType: "application/json",
    });
  }, []);

  useInterval({ interval: refreshIntervalMs, callback: submit });

  const data = fetcher.data?.success
    ? { rows: fetcher.data.data.rows, columns: fetcher.data.data.columns }
    : { rows: [], columns: [] };

  return (
    <QueryWidget
      title={title}
      config={config}
      isLoading={isLoading}
      data={data}
      error={fetcher.data?.success === false ? fetcher.data.error : undefined}
    />
  );
}
