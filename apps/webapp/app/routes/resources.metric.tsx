import type { OutputColumnMetadata } from "@internal/clickhouse";
import { useFetcher } from "@remix-run/react";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useEffect } from "react";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { executeQuery } from "~/services/queryService.server";
import {
  QueryWidget,
  type QueryWidgetConfig,
  type QueryWidgetData,
} from "~/components/metrics/QueryWidget";
import { useInterval } from "~/hooks/useInterval";

const Scope = z.union([z.literal("environment"), z.literal("organization"), z.literal("project")]);

// Response type for the action
type MetricWidgetActionResponse =
  | { success: false; error: string }
  | {
      success: true;
      data: {
        rows: Record<string, unknown>[];
        columns: OutputColumnMetadata[];
        stats: { elapsed_ns: string } | null;
        hiddenColumns: string[] | null;
        reachedMaxRows: boolean;
        periodClipped: number | null;
        maxQueryPeriod: number | undefined;
      };
    };

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
  /** Unique key for this widget - used to identify the fetcher */
  widgetKey: string;
  title: string;
  config: QueryWidgetConfig;
  refreshIntervalMs?: number;
  isResizing?: boolean;
  isDraggable?: boolean;
  /** Callback when edit button is clicked - receives current data */
  onEdit?: (data: QueryWidgetData) => void;
} & z.infer<typeof MetricWidgetQuery>;

export function MetricWidget({
  widgetKey,
  title,
  config,
  refreshIntervalMs,
  isResizing,
  isDraggable,
  onEdit,
  ...props
}: MetricWidgetProps) {
  const fetcher = useFetcher<MetricWidgetActionResponse>();
  const isLoading = fetcher.state !== "idle";

  const submit = useCallback(async () => {
    fetcher.submit(props, {
      method: "POST",
      action: `/resources/metric`,
      encType: "application/json",
    });
  }, [props]);

  // Reload periodically and on focus
  useInterval({ interval: refreshIntervalMs, callback: submit });

  // If the time period changes, reload
  useEffect(() => {
    submit();
  }, [props.from, props.to, props.period]);

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
      isResizing={isResizing}
      isDraggable={isDraggable}
      onEdit={onEdit}
    />
  );
}
