import type { OutputColumnMetadata } from "@internal/clickhouse";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { executeQuery } from "~/services/queryService.server";
import {
  QueryWidget,
  type QueryWidgetConfig,
  type QueryWidgetData,
} from "~/components/metrics/QueryWidget";
import { useElementVisibility } from "~/hooks/useElementVisibility";
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
        timeRange: { from: string; to: string };
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
    taskIdentifiers,
    queues,
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
      timeRange: {
        from: queryResult.timeRange.from.toISOString(),
        to: queryResult.timeRange.to.toISOString(),
      },
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
  /** Callback when rename is clicked - receives new title */
  onRename?: (newTitle: string) => void;
  /** Callback when delete is clicked */
  onDelete?: () => void;
  /** Callback when duplicate is clicked - receives current data */
  onDuplicate?: (data: QueryWidgetData) => void;
} & z.infer<typeof MetricWidgetQuery>;

export function MetricWidget({
  widgetKey,
  title,
  config,
  refreshIntervalMs,
  isResizing,
  isDraggable,
  onEdit,
  onRename,
  onDelete,
  onDuplicate,
  ...props
}: MetricWidgetProps) {
  const [response, setResponse] = useState<MetricWidgetActionResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track the latest props so the submit callback always uses fresh values
  // without needing to be recreated (which would cause useInterval to re-register listeners).
  const propsRef = useRef(props);
  propsRef.current = props;

  const submit = useCallback(() => {
    // Skip fetching if the widget is not visible on screen
    if (!isVisibleRef.current) return;

    // Abort any in-flight request for this widget
    abortControllerRef.current?.abort();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);

    fetch(`/resources/metric`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(propsRef.current),
      signal: controller.signal,
    })
      .then(async (res) => {
        try {
          return (await res.json()) as MetricWidgetActionResponse;
        } catch {
          throw new Error(`Request failed (${res.status})`);
        }
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setResponse(data);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!controller.signal.aborted) {
          // Only surface the error if there's no existing successful data to preserve
          setResponse((prev) =>
            prev?.success ? prev : { success: false, error: err.message || "Network error" }
          );
          setIsLoading(false);
        }
      });
  }, []);

  // Track visibility so we only fetch for on-screen widgets.
  // When a widget scrolls into view and has no data yet, trigger a load.
  const { ref: visibilityRef, isVisibleRef } = useElementVisibility({
    onVisibilityChange: (visible) => {
      if (visible && !response) {
        submit();
      }
    },
  });

  // Clean up on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Reload periodically and on focus (onLoad: false — the useEffect below handles initial load)
  useInterval({ interval: refreshIntervalMs, callback: submit, onLoad: false });

  // Reload on mount and when query, time period, or filters change
  useEffect(() => {
    submit();
  }, [
    submit,
    props.query,
    props.from,
    props.to,
    props.period,
    props.scope,
    JSON.stringify(props.taskIdentifiers),
    JSON.stringify(props.queues),
  ]);

  const data = response?.success
    ? { rows: response.data.rows, columns: response.data.columns }
    : { rows: [], columns: [] };

  const timeRange = response?.success ? response.data.timeRange : undefined;

  return (
    <div ref={visibilityRef} className="h-full">
      <QueryWidget
        title={title}
        titleString={title}
        query={props.query}
        config={config}
        isLoading={isLoading}
        data={data}
        timeRange={timeRange}
        error={response?.success === false ? response.error : undefined}
        isResizing={isResizing}
        isDraggable={isDraggable}
        onEdit={onEdit}
        onRename={onRename}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
      />
    </div>
  );
}
