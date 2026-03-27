import { type LoaderFunctionArgs, type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { type MetaFunction, Form, useNavigation, useSubmit } from "@remix-run/react";
import { BellAlertIcon, CheckIcon } from "@heroicons/react/20/solid";
import { IconAlarmSnooze as IconAlarmSnoozeBase } from "@tabler/icons-react";

const AlarmSnoozeIcon = ({ className }: { className?: string }) => (
  <IconAlarmSnoozeBase className={className} size={18} />
);
import { parse } from "@conform-to/zod";
import { z } from "zod";
import { ErrorStatusBadge } from "~/components/errors/ErrorStatusBadge";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { requireUser, requireUserId } from "~/services/session.server";
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
  type ErrorGroupState,
} from "~/presenters/v3/ErrorGroupPresenter.server";
import { type NextRunList } from "~/presenters/v3/NextRunListPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient, clickhouseClient } from "~/services/clickhouseInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody } from "~/components/layout/AppLayout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { AnimatePresence, motion } from "framer-motion";
import { Suspense, useMemo, useState } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { formatDistanceToNow, isPast } from "date-fns";

import * as Property from "~/components/primitives/PropertyTable";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { CopyableText } from "~/components/primitives/CopyableText";
import { cn } from "~/utils/cn";
import { LogsVersionFilter } from "~/components/logs/LogsVersionFilter";
import { getSeriesColor } from "~/components/code/chartColors";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
} from "~/components/primitives/Popover";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { ErrorGroupActions } from "~/v3/services/errorGroupActions.server";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  return [
    {
      title: `Error Details | Trigger.dev`,
    },
  ];
};

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("resolve"),
    taskIdentifier: z.string().min(1),
    resolvedInVersion: z.string().optional(),
  }),
  z.object({
    action: z.literal("ignore"),
    taskIdentifier: z.string().min(1),
    duration: z.coerce.number().positive().optional(),
    occurrenceRate: z.coerce.number().positive().optional(),
    totalOccurrences: z.coerce.number().positive().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal("unresolve"),
    taskIdentifier: z.string().min(1),
  }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const fingerprint = params.fingerprint;

  if (!fingerprint) {
    return json({ error: "Fingerprint parameter is required" }, { status: 400 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema: actionSchema });

  if (!submission.value) {
    return json(submission);
  }

  const actions = new ErrorGroupActions();
  const identifier = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    taskIdentifier: submission.value.taskIdentifier,
    errorFingerprint: fingerprint,
  };

  switch (submission.value.action) {
    case "resolve": {
      await actions.resolveError(identifier, {
        userId,
        resolvedInVersion: submission.value.resolvedInVersion,
      });
      return json({ ok: true });
    }
    case "ignore": {
      let occurrenceCountAtIgnoreTime: number | undefined;

      if (submission.value.totalOccurrences) {
        const qb = clickhouseClient.errors.listQueryBuilder();
        qb.where("project_id = {projectId: String}", { projectId: project.id });
        qb.where("environment_id = {environmentId: String}", {
          environmentId: environment.id,
        });
        qb.where("error_fingerprint = {fingerprint: String}", { fingerprint });
        qb.where("task_identifier = {taskIdentifier: String}", {
          taskIdentifier: submission.value.taskIdentifier,
        });
        qb.groupBy("error_fingerprint, task_identifier");

        const [err, results] = await qb.execute();
        if (!err && results && results.length > 0) {
          occurrenceCountAtIgnoreTime = results[0].occurrence_count;
        }
      }

      await actions.ignoreError(identifier, {
        userId,
        duration: submission.value.duration,
        occurrenceRateThreshold: submission.value.occurrenceRate,
        totalOccurrencesThreshold: submission.value.totalOccurrences,
        occurrenceCountAtIgnoreTime,
        reason: submission.value.reason,
      });
      return json({ ok: true });
    }
    case "unresolve": {
      await actions.unresolveError(identifier);
      return json({ ok: true });
    }
  }
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

  const alertsHref = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.set("alerts", "true");
    return `?${params.toString()}`;
  }, [location.search]);

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
                  alertsHref={alertsHref}
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
  alertsHref,
}: {
  errorGroup: ErrorGroupSummary | undefined;
  runList: NextRunList | undefined;
  activity: Promise<ErrorGroupOccurrences>;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  fingerprint: string;
  alertsHref: string;
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
    <ResizablePanelGroup orientation="horizontal" className="max-h-full">
      {/* Main content: chart + runs */}
      <ResizablePanel id="error-main" min="300px">
        <div className="grid h-full grid-rows-[12rem_1fr] overflow-hidden">
          {/* Activity chart */}
          <div className="flex flex-col gap-3 overflow-hidden border-b border-grid-bright bg-background-bright py-2 pl-2 pr-4">
            <div className="flex items-center gap-2">
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
            <div className="flex items-center justify-between pl-3 pr-2 pt-1">
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
      </ResizablePanel>

      {/* Right-hand detail sidebar */}
      <ResizableHandle id="error-detail-handle" />
      <ResizablePanel id="error-detail" min="280px" default="380px" max="500px" isStaticAtRest>
        <ErrorDetailSidebar
          errorGroup={errorGroup}
          fingerprint={fingerprint}
          alertsHref={alertsHref}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ErrorDetailSidebar({
  errorGroup,
  fingerprint,
  alertsHref,
}: {
  errorGroup: ErrorGroupSummary;
  fingerprint: string;
  alertsHref: string;
}) {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="truncate">Details</Header2>
        <LinkButton
          to={alertsHref}
          variant="secondary/small"
          LeadingIcon={BellAlertIcon}
          leadingIconClassName="text-alerts"
        >
          Configure alerts
        </LinkButton>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col gap-4">
          <Property.Table>
            {/* Status */}
            <Property.Item>
              <Property.Label>Error status</Property.Label>
              <Property.Value>
                <div className="flex items-center justify-between">
                  <ErrorStatusBadge status={errorGroup.state.status} className="w-fit" />
                  <ErrorStatusDropdown
                    state={errorGroup.state}
                    taskIdentifier={errorGroup.taskIdentifier}
                  />
                </div>

                <AnimatePresence>
                  {errorGroup.state.status === "IGNORED" && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: "easeInOut" }}
                      className="overflow-hidden"
                    >
                      <IgnoredDetails
                        className="mt-2"
                        state={errorGroup.state}
                        totalOccurrences={errorGroup.count}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </Property.Value>
            </Property.Item>

            {/* Error message */}
            <Property.Item>
              <Property.Label>Error</Property.Label>
              <Property.Value>
                <Paragraph variant="small" className="break-words font-mono">
                  {errorGroup.errorMessage}
                </Paragraph>
              </Property.Value>
            </Property.Item>
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
            <Property.Item>
              <Property.Label>Occurrences</Property.Label>
              <Property.Value>
                <span className="tabular-nums">{errorGroup.count.toLocaleString()}</span>
              </Property.Value>
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
                <RelativeDateTime date={errorGroup.lastSeen} />
              </Property.Value>
            </Property.Item>
            {errorGroup.affectedVersions.length > 0 && (
              <Property.Item>
                <Property.Label>Versions</Property.Label>
                <Property.Value>
                  <span className="font-mono text-sm">
                    {errorGroup.affectedVersions.join(", ")}
                  </span>
                </Property.Value>
              </Property.Item>
            )}
          </Property.Table>
        </div>
      </div>
    </div>
  );
}

function IgnoredDetails({
  state,
  totalOccurrences,
  className,
}: {
  state: ErrorGroupState;
  totalOccurrences: number;
  className?: string;
}) {
  if (state.status !== "IGNORED") {
    return null;
  }

  const hasConditions =
    state.ignoredUntil || state.ignoredUntilOccurrenceRate || state.ignoredUntilTotalOccurrences;

  const ignoredForever = !hasConditions;

  const occurrencesSinceIgnore =
    state.ignoredUntilTotalOccurrences && state.ignoredAtOccurrenceCount !== null
      ? totalOccurrences - state.ignoredAtOccurrenceCount
      : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded border border-text-dimmed/20 bg-text-dimmed/5 px-3 py-2.5 text-sm",
        className
      )}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <IconAlarmSnoozeBase className="size-4 text-text-dimmed" size={16} />
          <span className="font-medium text-text-bright">
            {ignoredForever ? "Ignored permanently" : "Ignored with conditions"}
          </span>
        </div>
        {(state.ignoredByUserDisplayName || state.ignoredAt) && (
          <span className="text-xs text-text-dimmed">
            {state.ignoredByUserDisplayName && <>Configured by {state.ignoredByUserDisplayName}</>}
            {state.ignoredByUserDisplayName && state.ignoredAt && " "}
            {state.ignoredAt && <RelativeDateTime date={state.ignoredAt} capitalize={false} />}
          </span>
        )}
      </div>

      {state.ignoredReason && (
        <div className="text-text-dimmed">
          Reason: <span className="text-text-bright">{state.ignoredReason}</span>
        </div>
      )}

      {hasConditions && (
        <div className="flex flex-col gap-1 text-xs text-text-dimmed">
          {state.ignoredUntil && (
            <span>
              Will revert to "Unresolved" at:{" "}
              <span className="text-text-bright">
                <DateTime date={state.ignoredUntil} />
              </span>
              {isPast(state.ignoredUntil) && <span className="ml-1 text-warning">(expired)</span>}
            </span>
          )}
          {state.ignoredUntilOccurrenceRate !== null && state.ignoredUntilOccurrenceRate > 0 && (
            <span>
              Will revert to "Unresolved" when: Occurrence rate exceeds{" "}
              <span className="tabular-nums text-text-bright">
                {state.ignoredUntilOccurrenceRate}/min
              </span>
            </span>
          )}
          {state.ignoredUntilTotalOccurrences !== null &&
            state.ignoredUntilTotalOccurrences > 0 && (
              <span>
                Will revert to "Unresolved" when: Total occurrences exceed{" "}
                <span className="tabular-nums text-text-bright">
                  {state.ignoredUntilTotalOccurrences.toLocaleString()}
                </span>
                {occurrencesSinceIgnore !== null && (
                  <span className="ml-1 tabular-nums text-text-dimmed">
                    ({occurrencesSinceIgnore.toLocaleString()} since ignored)
                  </span>
                )}
              </span>
            )}
        </div>
      )}
    </div>
  );
}

function ErrorStatusDropdown({
  state,
  taskIdentifier,
}: {
  state: ErrorGroupState;
  taskIdentifier: string;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [customIgnoreOpen, setCustomIgnoreOpen] = useState(false);
  const isSubmitting = navigation.state !== "idle";

  const act = (data: Record<string, string>) => {
    setPopoverOpen(false);
    submit(data, { method: "post" });
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverArrowTrigger variant="tertiary" disabled={isSubmitting}>
          Mark error as…
        </PopoverArrowTrigger>
        <PopoverContent className="inline-flex !min-w-0 flex-col p-1" align="end">
          {state.status === "UNRESOLVED" && (
            <>
              <PopoverMenuItem
                icon={CheckIcon}
                leadingIconClassName="text-success"
                title="Resolved"
                onClick={() => act({ taskIdentifier, action: "resolve" })}
              />
              <PopoverMenuItem
                icon={AlarmSnoozeIcon}
                title="Ignored for 1 hour"
                onClick={() =>
                  act({
                    taskIdentifier,
                    action: "ignore",
                    duration: String(60 * 60 * 1000),
                  })
                }
              />
              <PopoverMenuItem
                icon={AlarmSnoozeIcon}
                title="Ignored for 24 hours"
                onClick={() =>
                  act({
                    taskIdentifier,
                    action: "ignore",
                    duration: String(24 * 60 * 60 * 1000),
                  })
                }
              />
              <PopoverMenuItem
                icon={AlarmSnoozeIcon}
                title="Ignored forever"
                onClick={() => act({ taskIdentifier, action: "ignore" })}
              />
              <PopoverMenuItem
                icon={AlarmSnoozeIcon}
                title="Ignored with custom condition…"
                onClick={() => {
                  setPopoverOpen(false);
                  setCustomIgnoreOpen(true);
                }}
              />
            </>
          )}

          {state.status === "RESOLVED" && (
            <PopoverMenuItem
              title="Unresolved"
              onClick={() => act({ taskIdentifier, action: "unresolve" })}
            />
          )}

          {state.status === "IGNORED" && (
            <PopoverMenuItem
              title="Unresolved"
              onClick={() => act({ taskIdentifier, action: "unresolve" })}
            />
          )}
        </PopoverContent>
      </Popover>

      <Dialog open={customIgnoreOpen} onOpenChange={setCustomIgnoreOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom ignore condition</DialogTitle>
          </DialogHeader>
          <CustomIgnoreForm
            taskIdentifier={taskIdentifier}
            onClose={() => setCustomIgnoreOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function CustomIgnoreForm({
  taskIdentifier,
  onClose,
}: {
  taskIdentifier: string;
  onClose: () => void;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <Form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget, { method: "post" });
        setTimeout(onClose, 100);
      }}
    >
      <input type="hidden" name="action" value="ignore" />
      <input type="hidden" name="taskIdentifier" value={taskIdentifier} />

      <div className="flex flex-col gap-4 py-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="occurrenceRate" className="text-xs text-text-dimmed">
            Unignore when occurrence rate exceeds (per minute)
          </label>
          <input
            id="occurrenceRate"
            name="occurrenceRate"
            type="number"
            min={1}
            className="rounded border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:border-indigo-500 focus:outline-none"
            placeholder="e.g. 10"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="totalOccurrences" className="text-xs text-text-dimmed">
            Unignore when total occurrences exceed
          </label>
          <input
            id="totalOccurrences"
            name="totalOccurrences"
            type="number"
            min={1}
            className="rounded border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:border-indigo-500 focus:outline-none"
            placeholder="e.g. 100"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="reason" className="text-xs text-text-dimmed">
            Reason (optional)
          </label>
          <input
            id="reason"
            name="reason"
            type="text"
            className="rounded border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:border-indigo-500 focus:outline-none"
            placeholder="e.g. Known flaky test"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="tertiary/small" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary/small" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Ignoring..." : "Ignore error"}
        </Button>
      </DialogFooter>
    </Form>
  );
}

function ActivityChart({
  activity,
  versions,
}: {
  activity: ErrorGroupActivity;
  versions: ErrorGroupActivityVersions;
}) {
  const colors = useMemo(() => versions.map((_, i) => getSeriesColor(i)), [versions]);

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

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
        <XAxis
          dataKey="__timestamp"
          tickFormatter={xAxisFormatter}
          ticks={midnightTicks}
          height={40}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#878C99" }}
        />
        <YAxis
          width={30}
          tickMargin={4}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#878C99" }}
          domain={["auto", (dataMax: number) => dataMax * 1.15]}
        />
        <Tooltip
          cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
          content={<ActivityTooltip versions={versions} colors={colors} />}
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 1000 }}
          animationDuration={0}
        />
        {versions.map((version, i) => (
          <Bar
            key={version}
            dataKey={version}
            stackId="versions"
            fill={colors[i]}
            strokeWidth={0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

const ActivityTooltip = ({
  active,
  payload,
  versions,
  colors,
}: TooltipProps<number, string> & { versions: string[]; colors: string[] }) => {
  if (!active || !payload?.length) return null;

  const timestamp = payload[0]?.payload?.__timestamp as number | undefined;
  if (!timestamp) return null;

  const date = new Date(timestamp);
  const formattedDate = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
        <div className="mt-2 flex flex-col gap-1">
          {payload.map((entry, i) => {
            const value = (entry.value as number) ?? 0;
            return (
              <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
                <div className="size-2 rounded-[2px]" style={{ backgroundColor: entry.color }} />
                <span className="text-text-dimmed">{entry.dataKey}</span>
                <span className="tabular-nums text-text-bright">{value}</span>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipPortal>
  );
};

function ActivityChartBlankState() {
  return (
    <div className="flex min-h-0 flex-1 items-end gap-px rounded-sm">
      {[...Array(42)].map((_, i) => (
        <div key={i} className="h-full flex-1 bg-charcoal-850" />
      ))}
    </div>
  );
}
