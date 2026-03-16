import * as Ariakit from "@ariakit/react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { Form, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type ErrorGroupStatus } from "@trigger.dev/database";
import { IconBugFilled } from "@tabler/icons-react";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { Suspense, useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  type TooltipProps,
} from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { PageBody } from "~/components/layout/AppLayout";
import { SearchInput } from "~/components/primitives/SearchInput";
import { LogsTaskFilter } from "~/components/logs/LogsTaskFilter";
import { LogsVersionFilter } from "~/components/logs/LogsVersionFilter";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { formatDateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import {
  CopyableTableCell,
  Table,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { appliedSummary, FilterMenuProvider, TimeFilter } from "~/components/runs/v3/SharedFilters";
import { $replica } from "~/db.server";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  ErrorsListPresenter,
  type ErrorGroup,
  type ErrorOccurrenceActivity,
  type ErrorOccurrences,
  type ErrorsList as ErrorsListData,
} from "~/presenters/v3/ErrorsListPresenter.server";
import { logsClickhouseClient } from "~/services/clickhouseInstance.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { requireUser } from "~/services/session.server";
import { ListPagination } from "~/components/ListPagination";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { EnvironmentParamSchema, v3ErrorPath } from "~/utils/pathBuilder";
import { ServiceValidationError } from "~/v3/services/baseService.server";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Errors | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const url = new URL(request.url);
  const tasks = url.searchParams.getAll("tasks").filter((t) => t.length > 0);
  const versions = url.searchParams.getAll("versions").filter((v) => v.length > 0);
  const statuses = url.searchParams
    .getAll("status")
    .filter(
      (s): s is ErrorGroupStatus => s === "UNRESOLVED" || s === "RESOLVED" || s === "IGNORED"
    );
  const search = url.searchParams.get("search") ?? undefined;
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction");
  const direction =
    directionRaw === "forward" || directionRaw === "backward" ? directionRaw : undefined;

  const plan = await getCurrentPlan(project.organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  const presenter = new ErrorsListPresenter($replica, logsClickhouseClient);

  const listPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: tasks.length > 0 ? tasks : undefined,
      versions: versions.length > 0 ? versions : undefined,
      statuses: statuses.length > 0 ? statuses : undefined,
      search,
      period,
      from,
      to,
      cursor,
      direction,
      defaultPeriod: "1d",
      retentionLimitDays,
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  const occurrencesPromise = listPromise.then((result) => {
    if ("error" in result) return { data: {} };
    const fingerprints = result.errorGroups.map((g) => g.fingerprint);
    if (fingerprints.length === 0) return { data: {} };
    return presenter.getOccurrences(
      project.organizationId,
      project.id,
      environment.id,
      fingerprints,
      result.filters.from,
      result.filters.to
    );
  });

  return typeddefer({
    data: listPromise,
    occurrences: occurrencesPromise,
    defaultPeriod: "1d",
    retentionLimitDays,
    organizationSlug,
    projectParam,
    envParam,
  });
};

export default function Page() {
  const {
    data,
    occurrences,
    defaultPeriod,
    retentionLimitDays,
    organizationSlug,
    projectParam,
    envParam,
  } = useTypedLoaderData<typeof loader>();

  return (
    <>
      <NavBar>
        <PageTitle title="Errors" />
      </NavBar>

      <PageBody scrollable={false}>
        <Suspense
          fallback={
            <div className="grid h-full max-h-full grid-rows-[2.5rem_auto] overflow-hidden">
              <div className="border-b border-grid-bright" />
              <div className="my-2 flex items-center justify-center">
                <div className="mx-auto flex items-center gap-2">
                  <Spinner />
                  <Paragraph variant="small">Loading errors…</Paragraph>
                </div>
              </div>
            </div>
          }
        >
          <TypedAwait
            resolve={data}
            errorElement={
              <div className="grid h-full max-h-full grid-rows-[2.5rem_auto_1fr] overflow-hidden">
                <FiltersBar defaultPeriod={defaultPeriod} retentionLimitDays={retentionLimitDays} />
                <div className="flex items-center justify-center px-3 py-12">
                  <Callout variant="error" className="max-w-fit">
                    Unable to load errors. Please refresh the page or try again in a moment.
                  </Callout>
                </div>
              </div>
            }
          >
            {(result) => {
              if ("error" in result) {
                return (
                  <div className="grid h-full max-h-full grid-rows-[2.5rem_auto_1fr] overflow-hidden">
                    <FiltersBar
                      defaultPeriod={defaultPeriod}
                      retentionLimitDays={retentionLimitDays}
                    />
                    <div className="flex items-center justify-center px-3 py-12">
                      <Callout variant="error" className="max-w-fit">
                        {result.error}
                      </Callout>
                    </div>
                  </div>
                );
              }
              return (
                <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden">
                  <FiltersBar
                    list={result}
                    defaultPeriod={defaultPeriod}
                    retentionLimitDays={retentionLimitDays}
                  />
                  <ErrorsList
                    errorGroups={result.errorGroups}
                    occurrences={occurrences}
                    organizationSlug={organizationSlug}
                    projectParam={projectParam}
                    envParam={envParam}
                  />
                </div>
              );
            }}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </>
  );
}

const errorStatusOptions = [
  { value: "UNRESOLVED", label: "Unresolved" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "IGNORED", label: "Ignored" },
] as const;

const statusIcon = <IconBugFilled className="size-4" />;
const statusShortcut = { key: "s" };

function StatusFilter() {
  const { values, del } = useSearchParams();
  const selectedStatuses = values("status");

  if (selectedStatuses.length === 0 || selectedStatuses.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <ErrorStatusDropdown
            trigger={
              <SelectTrigger
                icon={statusIcon}
                variant="secondary/small"
                shortcut={statusShortcut}
                tooltipTitle="Filter by status"
              >
                <span className="ml-0.5">Status</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ErrorStatusDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Status"
                icon={statusIcon}
                value={appliedSummary(
                  selectedStatuses.map((s) => {
                    const opt = errorStatusOptions.find((o) => o.value === s);
                    return opt ? opt.label : s;
                  })
                )}
                onRemove={() => del(["status", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function ErrorStatusDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ status: values.length > 0 ? values : undefined, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return errorStatusOptions.filter((item) =>
      item.label.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider value={values("status")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }
          return true;
        }}
      >
        <ComboBox placeholder="Filter by status..." value={searchValue} />
        <SelectList>
          {filtered.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function FiltersBar({
  list,
  defaultPeriod,
  retentionLimitDays,
}: {
  list?: ErrorsListData;
  defaultPeriod?: string;
  retentionLimitDays: number;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("status") ||
    searchParams.has("tasks") ||
    searchParams.has("versions") ||
    searchParams.has("search") ||
    searchParams.has("period") ||
    searchParams.has("from") ||
    searchParams.has("to");

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-1">
        {list ? (
          <>
            <StatusFilter />
            <LogsTaskFilter possibleTasks={list.filters.possibleTasks} />
            <LogsVersionFilter />
            <TimeFilter
              defaultPeriod={defaultPeriod}
              maxPeriodDays={retentionLimitDays}
              labelName="Occurred"
            />
            <SearchInput placeholder="Search errors…" />
            {hasFilters && (
              <Form className="h-6">
                <Button
                  variant="secondary/small"
                  LeadingIcon={XMarkIcon}
                  tooltip="Clear all filters"
                />
              </Form>
            )}
          </>
        ) : (
          <>
            <StatusFilter />
            <LogsTaskFilter possibleTasks={[]} />
            <LogsVersionFilter />
            <TimeFilter defaultPeriod={defaultPeriod} maxPeriodDays={retentionLimitDays} />
            <SearchInput placeholder="Search errors…" />
            {hasFilters && (
              <Form className="h-6">
                <Button
                  variant="secondary/small"
                  LeadingIcon={XMarkIcon}
                  tooltip="Clear all filters"
                />
              </Form>
            )}
          </>
        )}
      </div>
      {list && <ListPagination list={list} />}
    </div>
  );
}

function ErrorsList({
  errorGroups,
  occurrences,
  organizationSlug,
  projectParam,
  envParam,
}: {
  errorGroups: ErrorGroup[];
  occurrences: Promise<ErrorOccurrences>;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
}) {
  if (errorGroups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Header3 className="mb-2">No errors found</Header3>
          <Paragraph variant="small">
            No errors have been recorded in the selected time period.
          </Paragraph>
        </div>
      </div>
    );
  }

  return (
    <Table containerClassName="max-h-full pb-[2.5rem]">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell>Error</TableHeaderCell>
          <TableHeaderCell>Occurrences</TableHeaderCell>
          <TableHeaderCell>Activity</TableHeaderCell>
          <TableHeaderCell>First seen</TableHeaderCell>
          <TableHeaderCell>Last seen</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {errorGroups.map((errorGroup) => (
          <ErrorGroupRow
            key={errorGroup.fingerprint}
            errorGroup={errorGroup}
            occurrences={occurrences}
            organizationSlug={organizationSlug}
            projectParam={projectParam}
            envParam={envParam}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function ErrorGroupRow({
  errorGroup,
  occurrences,
  organizationSlug,
  projectParam,
  envParam,
}: {
  errorGroup: ErrorGroup;
  occurrences: Promise<ErrorOccurrences>;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);

  const errorPath = useMemo(() => {
    const base = v3ErrorPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { fingerprint: errorGroup.fingerprint }
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
  }, [organizationSlug, projectParam, envParam, errorGroup.fingerprint, searchParams.toString()]);

  const errorMessage = `${errorGroup.errorMessage}`;

  return (
    <TableRow>
      <CopyableTableCell to={errorPath} value={ErrorId.toFriendlyId(errorGroup.fingerprint)}>
        {errorGroup.fingerprint.slice(-8)}
      </CopyableTableCell>
      <TableCell to={errorPath}>
        <ListStatusBadge status={errorGroup.status} />
      </TableCell>
      <TableCell to={errorPath}>{errorGroup.taskIdentifier}</TableCell>
      <CopyableTableCell to={errorPath} className="font-mono" value={errorMessage}>
        {errorMessage.length > 128 ? `${errorMessage.slice(0, 128)}…` : errorMessage}
      </CopyableTableCell>
      <TableCell to={errorPath}>{errorGroup.count.toLocaleString()}</TableCell>
      <TableCell to={errorPath} actionClassName="py-1.5">
        <Suspense fallback={<ErrorActivityBlankState />}>
          <TypedAwait resolve={occurrences} errorElement={<ErrorActivityBlankState />}>
            {(result) => {
              const activity = result.data[errorGroup.fingerprint];
              return activity ? (
                <ErrorActivityGraph activity={activity} />
              ) : (
                <ErrorActivityBlankState />
              );
            }}
          </TypedAwait>
        </Suspense>
      </TableCell>
      <TableCell to={errorPath}>
        <RelativeDateTime date={errorGroup.firstSeen} />
      </TableCell>
      <TableCell to={errorPath}>
        <RelativeDateTime date={errorGroup.lastSeen} />
      </TableCell>
    </TableRow>
  );
}

const LIST_STATUS_STYLES = {
  UNRESOLVED: "text-error",
  RESOLVED: "text-success",
  IGNORED: "text-text-dimmed",
} as const;

const LIST_STATUS_LABELS = {
  UNRESOLVED: "Unresolved",
  RESOLVED: "Resolved",
  IGNORED: "Ignored",
} as const;

function ListStatusBadge({ status }: { status: string }) {
  const s = (status as keyof typeof LIST_STATUS_STYLES) ?? "UNRESOLVED";
  return (
    <span className={`text-xs ${LIST_STATUS_STYLES[s] ?? LIST_STATUS_STYLES.UNRESOLVED}`}>
      {LIST_STATUS_LABELS[s] ?? "Unresolved"}
    </span>
  );
}

function ErrorActivityGraph({ activity }: { activity: ErrorOccurrenceActivity }) {
  const maxCount = Math.max(...activity.map((d) => d.count));

  return (
    <div className="flex items-start gap-1.5">
      <div className="h-6 w-[10.25rem] rounded-sm">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={activity} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <YAxis domain={[0, maxCount || 1]} hide />
            <Tooltip
              cursor={{ fill: "transparent" }}
              content={<ErrorActivityTooltip />}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            <Bar dataKey="count" fill="#6366F1" strokeWidth={0} isAnimationActive={false} />
            <ReferenceLine y={0} stroke="#2C3034" strokeWidth={1} />
            {maxCount > 0 && (
              <ReferenceLine y={maxCount} stroke="#4D525B" strokeDasharray="4 4" strokeWidth={1} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <span className="-mt-1 text-xxs tabular-nums text-text-dimmed">
        {formatNumberCompact(maxCount)}
      </span>
    </div>
  );
}

const ErrorActivityTooltip = ({ active, payload }: TooltipProps<number, string>) => {
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

function ErrorActivityBlankState() {
  return (
    <div className="flex h-6 w-[5.125rem] items-end gap-px rounded-sm">
      {[...Array(24)].map((_, i) => (
        <div key={i} className="h-full flex-1 bg-[#212327]" />
      ))}
    </div>
  );
}
