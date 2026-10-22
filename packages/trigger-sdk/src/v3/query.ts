import type {
  AddDashboardWidgetRequestBody,
  ApiRequestOptions,
  CreateDashboardRequestBody,
  Prettify,
  ReplaceDashboardRequestBody,
  UpdateDashboardRequestBody,
  UpdateDashboardWidgetRequestBody,
} from "@trigger.dev/core/v3";
import { apiClientManager, mergeRequestOptions } from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type { QueryTable, RunsTableRow, RunFriendlyStatus } from "@trigger.dev/core/v3";
export type {
  DashboardObject,
  DashboardSummary,
  DashboardWidget,
  DashboardWidgetDisplay,
  DashboardWidgetInput,
  DashboardWidgetPosition,
} from "@trigger.dev/core/v3";

export type QueryScope = "environment" | "project" | "organization";
export type QueryFormat = "json" | "csv";

/**
 * Options for executing a TRQL query
 */
export type QueryOptions = {
  /**
   * The scope of the query - determines what data is accessible
   * - "environment": Current environment only (default)
   * - "project": All environments in the project
   * - "organization": All projects in the organization
   *
   * @default "environment"
   */
  scope?: QueryScope;

  /**
   * Time period to query (e.g., "7d", "30d", "1h")
   * Cannot be used with `from` or `to`
   */
  period?: string;

  /**
   * Start of time range as a Date object or Unix timestamp in milliseconds.
   * Must be used with `to`.
   */
  from?: Date | number;

  /**
   * End of time range as a Date object or Unix timestamp in milliseconds.
   * Must be used with `from`.
   */
  to?: Date | number;

  /**
   * Response format
   * - "json": Returns structured data (default)
   * - "csv": Returns CSV string
   *
   * @default "json"
   */
  format?: QueryFormat;
};

/**
 * Execute a TRQL query and get the results as a CSV string.
 *
 * @param {string} query - The TRQL query string to execute
 * @param {QueryOptions & { format: "csv" }} options - Query options with `format: "csv"`
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration
 * @returns A promise resolving to `{ format: "csv", results: string }` where `results` is the raw CSV text
 *
 * @example
 * ```typescript
 * const csvResult = await query.execute(
 *   "SELECT run_id, status, triggered_at FROM runs",
 *   { format: "csv", period: "7d" }
 * );
 * const lines = csvResult.results.split('\n');
 * ```
 */
function execute(
  query: string,
  options: QueryOptions & { format: "csv" },
  requestOptions?: ApiRequestOptions
): Promise<{ format: "csv"; results: string }>;

/**
 * Execute a TRQL query and return typed JSON rows.
 *
 * @template TRow - The shape of each row in the result set. Use {@link QueryTable} for type-safe column access (e.g. `QueryTable<"runs", "status" | "run_id">`)
 * @param {string} query - The TRQL query string to execute
 * @param {QueryOptions} [options] - Optional query configuration
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration
 * @returns A promise resolving to `{ format: "json", results: Array<TRow> }`
 *
 * @example
 * ```typescript
 * // Basic query with defaults (environment scope, json format)
 * const result = await query.execute("SELECT run_id, status FROM runs LIMIT 10");
 * console.log(result.results); // Array<Record<string, any>>
 *
 * // Type-safe query using QueryTable with specific columns
 * const typedResult = await query.execute<QueryTable<"runs", "run_id" | "status" | "triggered_at">>(
 *   "SELECT run_id, status, triggered_at FROM runs LIMIT 10"
 * );
 * typedResult.results.forEach(row => {
 *   console.log(row.run_id, row.status); // Fully typed!
 * });
 *
 * // Inline type for aggregation queries
 * const stats = await query.execute<{ status: string; count: number }>(
 *   "SELECT status, COUNT(*) as count FROM runs GROUP BY status"
 * );
 * stats.results.forEach(row => {
 *   console.log(row.status, row.count); // Fully type-safe
 * });
 *
 * // Query with a custom time period
 * const recent = await query.execute(
 *   "SELECT COUNT(*) as count FROM runs",
 *   { period: "3d" }
 * );
 * console.log(recent.results[0].count);
 * ```
 */
function execute<TRow extends Record<string, any> = Record<string, any>>(
  query: string,
  options?: Omit<QueryOptions, "format"> | (QueryOptions & { format?: "json" }),
  requestOptions?: ApiRequestOptions
): Promise<{ format: "json"; results: Array<Prettify<TRow>> }>;

// Implementation
function execute<TRow extends Record<string, any> = Record<string, any>>(
  query: string,
  options?: QueryOptions,
  requestOptions?: ApiRequestOptions
): Promise<{ format: "json"; results: Array<TRow> } | { format: "csv"; results: string }> {
  const apiClient = apiClientManager.clientOrThrow();

  const from = dateToISOString(options?.from);
  const to = dateToISOString(options?.to);

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "query.execute()",
      icon: "query",
      attributes: {
        scope: options?.scope ?? "environment",
        format: options?.format ?? "json",
        query,
        period: options?.period,
        from,
        to,
      },
    },
    requestOptions
  );

  return apiClient
    .executeQuery(
      query,
      {
        scope: options?.scope,
        period: options?.period,
        from,
        to,
        format: options?.format,
      },
      $requestOptions
    )
    .then((response) => {
      return response;
    }) as Promise<{ format: "json"; results: Array<TRow> } | { format: "csv"; results: string }>;
}

function dateToISOString(date: Date | number | undefined): string | undefined {
  if (date === undefined) {
    return undefined;
  }

  if (date instanceof Date) {
    return date.toISOString();
  }

  return new Date(date).toISOString();
}

function dashboardRequestOptions(
  name: string,
  attributes: Record<string, string | undefined>,
  requestOptions?: ApiRequestOptions
) {
  return mergeRequestOptions({ tracer, name, icon: "query", attributes }, requestOptions);
}

/**
 * Lists the built-in dashboards and your organization's custom dashboards, with their widgets.
 */
function listDashboards(requestOptions?: ApiRequestOptions) {
  return apiClientManager
    .clientOrThrow()
    .listDashboards(dashboardRequestOptions("query.dashboards.list()", {}, requestOptions));
}

/**
 * Retrieves a custom dashboard, including every widget, its query and its grid position.
 */
function retrieveDashboard(dashboardId: string, requestOptions?: ApiRequestOptions) {
  return apiClientManager
    .clientOrThrow()
    .retrieveDashboard(
      dashboardId,
      dashboardRequestOptions("query.dashboards.retrieve()", { dashboardId }, requestOptions)
    );
}

/**
 * Creates a custom dashboard, optionally with its widgets.
 *
 * @example
 * ```ts
 * const dashboard = await query.dashboards.create({
 *   title: "Email tasks",
 *   widgets: [
 *     {
 *       title: "Runs per day",
 *       query: "SELECT timeBucket(), count() AS runs FROM runs GROUP BY timeBucket ORDER BY timeBucket",
 *       display: {
 *         type: "chart",
 *         chartType: "bar",
 *         xAxisColumn: "timebucket",
 *         yAxisColumns: ["runs"],
 *         groupByColumn: null,
 *         stacked: false,
 *         sortByColumn: null,
 *         sortDirection: "asc",
 *         aggregation: "sum",
 *       },
 *     },
 *   ],
 * });
 * ```
 */
function createDashboard(body: CreateDashboardRequestBody, requestOptions?: ApiRequestOptions) {
  return apiClientManager
    .clientOrThrow()
    .createDashboard(
      body,
      dashboardRequestOptions("query.dashboards.create()", { title: body.title }, requestOptions)
    );
}

/**
 * Renames a custom dashboard or changes its description.
 */
function updateDashboard(
  dashboardId: string,
  body: UpdateDashboardRequestBody,
  requestOptions?: ApiRequestOptions
) {
  return apiClientManager
    .clientOrThrow()
    .updateDashboard(
      dashboardId,
      body,
      dashboardRequestOptions("query.dashboards.update()", { dashboardId }, requestOptions)
    );
}

/**
 * Replaces every widget on a custom dashboard. A widget that already exists keeps its position
 * unless you pass a new one; new widgets without a `position` are placed full width below the others,
 * in order. Pass the `revision` you last read to reject the write if someone else changed the
 * dashboard in the meantime.
 */
function replaceDashboard(
  dashboardId: string,
  body: ReplaceDashboardRequestBody,
  requestOptions?: ApiRequestOptions
) {
  return apiClientManager
    .clientOrThrow()
    .replaceDashboard(
      dashboardId,
      body,
      dashboardRequestOptions("query.dashboards.replace()", { dashboardId }, requestOptions)
    );
}

/**
 * Deletes a custom dashboard.
 */
function deleteDashboard(dashboardId: string, requestOptions?: ApiRequestOptions) {
  return apiClientManager
    .clientOrThrow()
    .deleteDashboard(
      dashboardId,
      dashboardRequestOptions("query.dashboards.del()", { dashboardId }, requestOptions)
    );
}

/**
 * Adds a widget to a custom dashboard. Without a `position` it is placed full width at the bottom.
 */
function addDashboardWidget(
  dashboardId: string,
  body: AddDashboardWidgetRequestBody,
  requestOptions?: ApiRequestOptions
) {
  return apiClientManager
    .clientOrThrow()
    .addDashboardWidget(
      dashboardId,
      body,
      dashboardRequestOptions("query.dashboards.widgets.add()", { dashboardId }, requestOptions)
    );
}

/**
 * Changes a widget's title, query, display, or position.
 */
function updateDashboardWidget(
  dashboardId: string,
  widgetId: string,
  body: UpdateDashboardWidgetRequestBody,
  requestOptions?: ApiRequestOptions
) {
  return apiClientManager
    .clientOrThrow()
    .updateDashboardWidget(
      dashboardId,
      widgetId,
      body,
      dashboardRequestOptions(
        "query.dashboards.widgets.update()",
        { dashboardId, widgetId },
        requestOptions
      )
    );
}

/**
 * Removes a widget from a custom dashboard.
 */
function deleteDashboardWidget(
  dashboardId: string,
  widgetId: string,
  options?: { revision?: string },
  requestOptions?: ApiRequestOptions
) {
  return apiClientManager
    .clientOrThrow()
    .deleteDashboardWidget(
      dashboardId,
      widgetId,
      options,
      dashboardRequestOptions(
        "query.dashboards.widgets.del()",
        { dashboardId, widgetId },
        requestOptions
      )
    );
}

export const query = {
  execute,
  dashboards: {
    list: listDashboards,
    retrieve: retrieveDashboard,
    create: createDashboard,
    update: updateDashboard,
    replace: replaceDashboard,
    del: deleteDashboard,
    widgets: {
      add: addDashboardWidget,
      update: updateDashboardWidget,
      del: deleteDashboardWidget,
    },
  },
};
