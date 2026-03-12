import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type MetaFunction } from "@remix-run/react";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3CreateBulkActionPath,
  v3ErrorsPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  ErrorGroupPresenter,
  type ErrorGroupActivity,
  type ErrorGroupActivityVersions,
  type ErrorGroupOccurrences,
  type ErrorGroupSummary,
} from "~/presenters/v3/ErrorGroupPresenter.server";
import { type NextRunList } from "~/presenters/v3/NextRunListPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient, clickhouseClient } from "~/services/clickhouseInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody } from "~/components/layout/AppLayout";
import { Suspense, useMemo } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { formatDistanceToNow } from "date-fns";
import { formatNumberCompact } from "~/utils/numberFormatter";
import * as Property from "~/components/primitives/PropertyTable";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { CopyableText } from "~/components/primitives/CopyableText";
import { LogsVersionFilter } from "~/components/logs/LogsVersionFilter";
import { getSeriesColor } from "~/components/code/chartColors";

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

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;
  const versions = url.searchParams.getAll("versions").filter((v) => v.length > 0);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction") ?? undefined;
  const direction = directionRaw ? DirectionSchema.parse(directionRaw) : undefined;

  const presenter = new ErrorGroupPresenter($replica, logsClickhouseClient, clickhouseClient);

  const detailPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      fingerprint,
      versions: versions.length > 0 ? versions : undefined,
      period,
      from,
      to,
      cursor,
      direction,
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const activityPromise = presenter
    .getOccurrences(
      project.organizationId,
      project.id,
      environment.id,
      fingerprint,
      time.from,
      time.to,
      versions.length > 0 ? versions : undefined
    )
    .catch(() => ({ data: [] as ErrorGroupActivity, versions: [] as string[] }));

  return typeddefer({
    data: detailPromise,
    activity: activityPromise,
    organizationSlug,
    projectParam,
    envParam,
    fingerprint,
  });
};

export default function Page() {
  const { data, activity, organizationSlug, projectParam, envParam, fingerprint } =
    useTypedLoaderData<typeof loader>();

  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);

  const errorsPath = useMemo(() => {
    const base = v3ErrorsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );
    const carry = new URLSearchParams();
    const period = searchParams.get("period");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (period) carry.set("period", period);
    if (from) carry.set("from", from);
    if (to) carry.set("to", to);
    for (const v of searchParams.getAll("versions")) {
      if (v) carry.append("versions", v);
    }
    const qs = carry.toString();
    return qs ? `${base}?${qs}` : base;
  }, [organizationSlug, projectParam, envParam, searchParams.toString()]);

  return (
    <>
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
                  activity={activity}
                  organizationSlug={organizationSlug}
                  projectParam={projectParam}
                  envParam={envParam}
                  fingerprint={fingerprint}
                />
              );
            }}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </>
  );
}

function ErrorGroupDetail({
  errorGroup,
  runList,
  activity,
  organizationSlug,
  projectParam,
  envParam,
  fingerprint,
}: {
  errorGroup: ErrorGroupSummary | undefined;
  runList: NextRunList | undefined;
  activity: Promise<ErrorGroupOccurrences>;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  fingerprint: string;
}) {
  const { value, values } = useSearchParams();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

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

  const fromValue = value("from") ?? undefined;
  const toValue = value("to") ?? undefined;
  const selectedVersions = values("versions").filter((v) => v !== "");

  const filters: TaskRunListSearchFilters = {
    period: value("period") ?? undefined,
    from: fromValue ? parseInt(fromValue, 10) : undefined,
    to: toValue ? parseInt(toValue, 10) : undefined,
    versions: selectedVersions.length > 0 ? selectedVersions : undefined,
    rootOnly: false,
    errorId: ErrorId.toFriendlyId(fingerprint),
  };

  return (
    <div className="grid h-full grid-rows-[auto_12rem_1fr] overflow-hidden">
      {/* Error Summary */}
      <div className="flex flex-col gap-2 border-b border-grid-bright bg-background-bright p-4">
        <div className="flex flex-col gap-0.5">
          <Header2>{errorGroup.errorMessage}</Header2>
          <Header3>{formatNumberCompact(errorGroup.count)} total occurrences</Header3>
        </div>

        <div className="grid grid-cols-[auto_auto_auto_1fr] gap-x-12 gap-y-0.5">
          <Property.Table>
            <Property.Item>
              <Property.Label>ID</Property.Label>
              <Property.Value>
                <CopyableText value={ErrorId.toFriendlyId(errorGroup.fingerprint)} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Task</Property.Label>
              <Property.Value>
                <CopyableText value={errorGroup.taskIdentifier} />
              </Property.Value>
            </Property.Item>
          </Property.Table>

          <Property.Table>
            <Property.Item>
              <Property.Label>First seen</Property.Label>
              <Property.Value>
                <DateTime date={errorGroup.firstSeen} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Last seen</Property.Label>
              <Property.Value>
                <RelativeDateTime date={errorGroup.lastSeen} />
              </Property.Value>
            </Property.Item>
          </Property.Table>

          <Property.Table>
            {errorGroup.affectedVersions.length > 0 && (
              <Property.Item>
                <Property.Label>Affected versions</Property.Label>
                <Property.Value>
                  <span className="font-mono text-xs">
                    {errorGroup.affectedVersions.join(", ")}
                  </span>
                </Property.Value>
              </Property.Item>
            )}
          </Property.Table>
        </div>
      </div>

      {/* Activity chart */}
      <div className="flex flex-col gap-3 overflow-hidden border-b border-grid-bright px-4 py-3">
        <div className="flex items-center gap-1">
          <TimeFilter defaultPeriod="7d" labelName="Occurred" />
          <LogsVersionFilter />
        </div>

        <Suspense fallback={<ActivityChartBlankState />}>
          <TypedAwait resolve={activity} errorElement={<ActivityChartBlankState />}>
            {(result) => {
              if (result.data.length > 0 && result.versions.length > 0) {
                return <ActivityChart activity={result.data} versions={result.versions} />;
              }
              return <ActivityChartBlankState />;
            }}
          </TypedAwait>
        </Suspense>
      </div>

      {/* Runs Table */}
      <div className="flex flex-col gap-1 overflow-y-hidden">
        <div className="flex items-center justify-between px-4">
          <Header3 className="mb-1 mt-2">Runs</Header3>
          {runList && (
            <div className="flex items-center gap-2">
              <LinkButton
                variant="secondary/small"
                to={v3RunsPath(organization, project, environment, filters)}
                LeadingIcon={RunsIcon}
              >
                View all runs
              </LinkButton>
              <LinkButton
                variant="secondary/small"
                to={v3CreateBulkActionPath(
                  organization,
                  project,
                  environment,
                  filters,
                  "filter",
                  "replay"
                )}
                LeadingIcon={ListCheckedIcon}
              >
                Bulk replay…
              </LinkButton>
              <ListPagination list={runList} />
            </div>
          )}
        </div>
        {runList ? (
          <TaskRunsTable
            total={runList.runs.length}
            hasFilters={selectedVersions.length > 0}
            filters={{
              tasks: [],
              versions: selectedVersions,
              statuses: [],
              from: undefined,
              to: undefined,
            }}
            runs={runList.runs}
            isLoading={false}
            variant="dimmed"
            additionalTableState={{ errorId: ErrorId.toFriendlyId(fingerprint) }}
          />
        ) : (
          <Paragraph variant="small" className="p-4 text-text-dimmed">
            No runs found for this error.
          </Paragraph>
        )}
      </div>
    </div>
  );
}

function ActivityChart({
  activity,
  versions,
}: {
  activity: ErrorGroupActivity;
  versions: ErrorGroupActivityVersions;
}) {
  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (let i = 0; i < versions.length; i++) {
      cfg[versions[i]] = {
        label: versions[i],
        color: getSeriesColor(i),
      };
    }
    return cfg;
  }, [versions]);

  const data = useMemo(
    () =>
      activity.map((d) => ({
        ...d,
        __timestamp: d.date instanceof Date ? d.date.getTime() : new Date(d.date).getTime(),
      })),
    [activity]
  );

  const midnightTicks = useMemo(() => {
    const ticks: number[] = [];
    for (const d of data) {
      const date = new Date(d.__timestamp);
      if (date.getHours() === 0 && date.getMinutes() === 0) {
        ticks.push(d.__timestamp);
      }
    }
    return ticks;
  }, [data]);

  const xAxisFormatter = useMemo(() => {
    return (value: number) => {
      const date = new Date(value);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    };
  }, []);

  const tooltipLabelFormatter = useMemo(() => {
    return (_label: string, payload: Array<{ payload?: Record<string, unknown> }>) => {
      const timestamp = payload[0]?.payload?.__timestamp as number | undefined;
      if (timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      }
      return _label;
    };
  }, []);

  return (
    <Chart.Root
      config={chartConfig}
      data={data}
      dataKey="__timestamp"
      series={versions}
      fillContainer
    >
      <Chart.Bar
        stackId="versions"
        xAxisProps={{
          tickFormatter: xAxisFormatter,
          ticks: midnightTicks,
          height: 40,
        }}
        yAxisProps={{
          width: 30,
          tickMargin: 4,
        }}
        tooltipLabelFormatter={tooltipLabelFormatter}
      />
    </Chart.Root>
  );
}

function ActivityChartBlankState() {
  return (
    <div className="flex min-h-0 flex-1 items-end gap-px rounded-sm">
      {[...Array(42)].map((_, i) => (
        <div key={i} className="h-full flex-1 bg-charcoal-850" />
      ))}
    </div>
  );
}
