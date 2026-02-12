import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { QueryEditor } from "~/components/query/QueryEditor";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueryPresenter } from "~/presenters/v3/QueryPresenter.server";
import { executeQuery, getDefaultPeriod } from "~/services/queryService.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema, queryPath } from "~/utils/pathBuilder";
import { canAccessQuery } from "~/v3/canAccessQuery.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";

/** Convert a Date or ISO string to ISO string format */
function toISOString(value: Date | string): string {
  if (typeof value === "string") {
    return value;
  }
  return value.toISOString();
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const canAccess = await canAccessQuery({
    userId: user.id,
    isAdmin: user.admin,
    isImpersonating: user.isImpersonating,
    organizationSlug,
  });
  if (!canAccess) {
    throw redirect("/");
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new QueryPresenter();
  const { defaultQuery, history } = await presenter.call({
    organizationId: project.organizationId,
  });

  // Admins and impersonating users can use EXPLAIN
  const isAdmin = user.admin || user.isImpersonating;

  return typedjson({
    defaultQuery,
    defaultPeriod: await getDefaultPeriod(project.organizationId),
    history,
    isAdmin,
    maxRows: env.QUERY_CLICKHOUSE_MAX_RETURNED_ROWS,
  });
};

const ActionSchema = z.object({
  query: z.string().min(1, "Query is required"),
  scope: z.enum(["environment", "project", "organization"]),
  explain: z.enum(["true", "false"]).nullable().optional(),
  period: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const canAccess = await canAccessQuery({
    userId: user.id,
    isAdmin: user.admin,
    isImpersonating: user.isImpersonating,
    organizationSlug,
  });
  if (!canAccess) {
    return typedjson(
      {
        error: "Unauthorized",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 403 }
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    return typedjson(
      {
        error: "Project not found",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 404 }
    );
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    return typedjson(
      {
        error: "Environment not found",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const parsed = ActionSchema.safeParse({
    query: formData.get("query"),
    scope: formData.get("scope"),
    explain: formData.get("explain"),
    period: formData.get("period"),
    from: formData.get("from"),
    to: formData.get("to"),
  });

  if (!parsed.success) {
    return typedjson(
      {
        error: parsed.error.errors.map((e) => e.message).join(", "),
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 400 }
    );
  }

  const { query, scope, explain: explainParam, period, from, to } = parsed.data;
  // Only allow explain for admins/impersonating users
  const isAdmin = user.admin || user.isImpersonating;
  const explain = explainParam === "true" && isAdmin;

  try {
    const queryResult = await executeQuery({
      name: "query-page",
      query,
      scope,
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      explain,
      period,
      from,
      to,
      history: {
        source: "DASHBOARD",
        userId: user.id,
        skip: user.isImpersonating,
      },
    });

    if (!queryResult.success) {
      return typedjson(
        {
          error: queryResult.error.message,
          rows: null,
          columns: null,
          stats: null,
          hiddenColumns: null,
          reachedMaxRows: null,
          explainOutput: null,
          generatedSql: null,
          queryId: null,
          periodClipped: null,
        },
        { status: 400 }
      );
    }

    return typedjson({
      error: null,
      rows: queryResult.result.rows,
      columns: queryResult.result.columns,
      stats: queryResult.result.stats,
      hiddenColumns: queryResult.result.hiddenColumns ?? null,
      reachedMaxRows: queryResult.result.reachedMaxRows,
      explainOutput: queryResult.result.explainOutput ?? null,
      generatedSql: queryResult.result.generatedSql ?? null,
      queryId: queryResult.queryId,
      periodClipped: queryResult.periodClipped,
      maxQueryPeriod: queryResult.maxQueryPeriod,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error executing query";
    return typedjson(
      {
        error: errorMessage,
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        queryId: null,
        periodClipped: null,
      },
      { status: 500 }
    );
  }
};

export default function Page() {
  const { defaultPeriod, defaultQuery, history, isAdmin, maxRows } =
    useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  // Use most recent history item if available, otherwise fall back to defaults
  const initialQuery = history.length > 0 ? history[0].query : defaultQuery;
  const initialScope = history.length > 0 ? history[0].scope : "environment";
  const initialTimeFilter =
    history.length > 0
      ? {
          period: history[0].filterPeriod ?? undefined,
          from: history[0].filterFrom ? toISOString(history[0].filterFrom) : undefined,
          to: history[0].filterTo ? toISOString(history[0].filterTo) : undefined,
        }
      : undefined;

  // Build the query action URL for this page
  const queryActionUrl = queryPath(
    { slug: organization.slug },
    { slug: project.slug },
    { slug: environment.slug }
  );

  return (
    <QueryEditor
      defaultQuery={initialQuery}
      defaultScope={initialScope}
      defaultPeriod={defaultPeriod}
      defaultTimeFilter={initialTimeFilter}
      history={history}
      isAdmin={isAdmin}
      maxRows={maxRows}
      queryActionUrl={queryActionUrl}
      mode={{ type: "standalone" }}
      maxPeriodDays={maxPeriodDays}
    />
  );
}
