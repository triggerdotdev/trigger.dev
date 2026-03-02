import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type MetaFunction } from "@remix-run/react";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema, v3ErrorsPath } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  ErrorGroupPresenter,
  type ErrorGroupHourlyActivity,
  type ErrorGroupSummary,
} from "~/presenters/v3/ErrorGroupPresenter.server";
import {
  NextRunListPresenter,
  type NextRunList,
} from "~/presenters/v3/NextRunListPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient, clickhouseClient } from "~/services/clickhouseInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { formatDistanceToNow } from "date-fns";
import { formatNumberCompact } from "~/utils/numberFormatter";
import * as Property from "~/components/primitives/PropertyTable";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { DateTime, formatDateTime } from "~/components/primitives/DateTime";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  type TooltipProps,
} from "recharts";
import TooltipPortal from "~/components/primitives/TooltipPortal";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  return [
    {
      title: `Error Details | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);
  const fingerprint = params.fingerprint;

  if (!fingerprint) {
    throw new Response("Fingerprint parameter is required", { status: 400 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const presenter = new ErrorGroupPresenter($replica, logsClickhouseClient);

  const detailPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      fingerprint,
    })
    .then(async (result) => {
      if (result.runFriendlyIds.length === 0) {
        return { ...result, runList: undefined };
      }

      const runListPresenter = new NextRunListPresenter($replica, clickhouseClient);
      const runList = await runListPresenter.call(project.organizationId, environment.id, {
        userId,
        projectId: project.id,
        runId: result.runFriendlyIds,
        pageSize: 25,
      });

      return {
        ...result,
        runList,
      };
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  const hourlyActivityPromise = presenter
    .getHourlyOccurrences(project.organizationId, project.id, environment.id, fingerprint)
    .catch(() => [] as ErrorGroupHourlyActivity);

  return typeddefer({
    data: detailPromise,
    hourlyActivity: hourlyActivityPromise,
    organizationSlug,
    projectParam,
    envParam,
    fingerprint,
  });
};

export default function Page() {
  const { data, hourlyActivity, organizationSlug, projectParam, envParam, fingerprint } =
    useTypedLoaderData<typeof loader>();

  const errorsPath = v3ErrorsPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam }
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          backButton={{
            to: errorsPath,
            text: "Errors",
          }}
          title={<span className="font-mono text-xs">{ErrorId.toFriendlyId(fingerprint)}</span>}
        />
      </NavBar>

      <PageBody scrollable={false}>
        <Suspense
          fallback={
            <div className="my-2 flex items-center justify-center">
              <div className="mx-auto flex items-center gap-2">
                <Spinner />
                <Paragraph variant="small">Loading error details…</Paragraph>
              </div>
            </div>
          }
        >
          <TypedAwait
            resolve={data}
            errorElement={
              <div className="flex items-center justify-center px-3 py-12">
                <Callout variant="error" className="max-w-fit">
                  Unable to load error details. Please refresh the page or try again in a moment.
                </Callout>
              </div>
            }
          >
            {(result) => {
              if ("error" in result) {
                return (
                  <div className="flex items-center justify-center px-3 py-12">
                    <Callout variant="error" className="max-w-fit">
                      {result.error}
                    </Callout>
                  </div>
                );
              }
              return (
                <ErrorGroupDetail
                  errorGroup={result.errorGroup}
                  runList={result.runList}
                  hourlyActivity={hourlyActivity}
                  organizationSlug={organizationSlug}
                  projectParam={projectParam}
                  envParam={envParam}
                />
              );
            }}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </PageContainer>
  );
}

function ErrorGroupDetail({
  errorGroup,
  runList,
  hourlyActivity,
  organizationSlug,
  projectParam,
  envParam,
}: {
  errorGroup: ErrorGroupSummary | undefined;
  runList: NextRunList | undefined;
  hourlyActivity: Promise<ErrorGroupHourlyActivity>;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
}) {
  if (!errorGroup) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Header3 className="mb-2">Error not found</Header3>
          <Paragraph variant="small">
            This error group does not exist or has no instances.
          </Paragraph>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-rows-[auto_auto_1fr] overflow-hidden">
      {/* Error Summary */}
      <div className="border-b border-grid-bright p-4">
        <Header2 className="mb-4">{errorGroup.errorMessage}</Header2>

        <div className="grid grid-cols-2 gap-x-12 gap-y-1">
          <Property.Table>
            <Property.Item>
              <Property.Label>ID</Property.Label>
              <Property.Value>
                <span className="font-mono">{ErrorId.toFriendlyId(errorGroup.fingerprint)}</span>
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Task</Property.Label>
              <Property.Value>
                <span className="font-mono">{errorGroup.taskIdentifier}</span>
              </Property.Value>
            </Property.Item>
          </Property.Table>

          <Property.Table>
            <Property.Item>
              <Property.Label>Occurrences</Property.Label>
              <Property.Value>{formatNumberCompact(errorGroup.count)}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>First seen</Property.Label>
              <Property.Value>
                <DateTime date={errorGroup.firstSeen} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Last seen</Property.Label>
              <Property.Value>
                {formatDistanceToNow(errorGroup.lastSeen, { addSuffix: true })}
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </div>

        {errorGroup.stackTrace && (
          <div className="mt-4 rounded-md bg-charcoal-900 p-4">
            <Paragraph variant="small" className="mb-2 font-semibold text-text-bright">
              Stack Trace
            </Paragraph>
            <pre className="overflow-x-auto text-xs text-text-dimmed">
              <code>{errorGroup.stackTrace}</code>
            </pre>
          </div>
        )}
      </div>

      {/* Activity over past 7 days by hour */}
      <div className="border-b border-grid-bright px-4 py-3">
        <Header3 className="mb-2">Activity (past 7 days)</Header3>
        <Suspense fallback={<ActivityChartBlankState />}>
          <TypedAwait
            resolve={hourlyActivity}
            errorElement={<ActivityChartBlankState />}
          >
            {(activity) =>
              activity.length > 0 ? (
                <ActivityChart activity={activity} />
              ) : (
                <ActivityChartBlankState />
              )
            }
          </TypedAwait>
        </Suspense>
      </div>

      {/* Runs Table */}
      <div className="flex flex-col gap-1 overflow-y-hidden">
        <Header3 className="mt-2 mb-1 px-4">Recent runs</Header3>
        {runList ? (
          <TaskRunsTable
            total={runList.runs.length}
            hasFilters={false}
            filters={{
              tasks: [],
              versions: [],
              statuses: [],
              from: undefined,
              to: undefined,
            }}
            runs={runList.runs}
            isLoading={false}
            variant="dimmed"
            disableAdjacentRows
          />
        ) : (
          <Paragraph variant="small" className="text-text-dimmed">
            No runs found for this error.
          </Paragraph>
        )}
      </div>
    </div>
  );
}

function ActivityChart({ activity }: { activity: ErrorGroupHourlyActivity }) {
  const maxCount = Math.max(...activity.map((d) => d.count));

  return (
    <div className="flex items-start gap-2">
      <div className="h-16 flex-1 rounded-sm">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={activity} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <YAxis domain={[0, maxCount || 1]} hide />
            <Tooltip
              cursor={{ fill: "transparent" }}
              content={<ActivityChartTooltip />}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            <Bar dataKey="count" fill="#EC003F" strokeWidth={0} isAnimationActive={false} />
            <ReferenceLine y={0} stroke="#B5B8C0" strokeWidth={1} />
            {maxCount > 0 && (
              <ReferenceLine
                y={maxCount}
                stroke="#B5B8C0"
                strokeDasharray="3 2"
                strokeWidth={1}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <span className="text-xxs tabular-nums text-text-dimmed">
        {formatNumberCompact(maxCount)}
      </span>
    </div>
  );
}

const ActivityChartTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  if (active && payload && payload.length > 0) {
    const entry = payload[0].payload as { date: Date; count: number };
    const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
    const formattedDate = formatDateTime(date, "UTC", [], false, true);

    return (
      <TooltipPortal active={active}>
        <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
          <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
          <div className="mt-2 text-xs text-text-bright">
            <span className="tabular-nums">{entry.count}</span>{" "}
            <span className="text-text-dimmed">
              {entry.count === 1 ? "occurrence" : "occurrences"}
            </span>
          </div>
        </div>
      </TooltipPortal>
    );
  }

  return null;
};

function ActivityChartBlankState() {
  return (
    <div className="flex h-16 w-full items-end gap-px rounded-sm">
      {[...Array(42)].map((_, i) => (
        <div key={i} className="h-full flex-1 bg-charcoal-850" />
      ))}
    </div>
  );
}
