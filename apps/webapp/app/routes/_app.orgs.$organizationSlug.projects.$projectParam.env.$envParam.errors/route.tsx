import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type MetaFunction, Form, Link, Outlet } from "@remix-run/react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { EnvironmentParamSchema, v3ErrorPath } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ErrorsListPresenter, type ErrorGroup } from "~/presenters/v3/ErrorsListPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient } from "~/services/clickhouseInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense, useMemo } from "react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { LogsSearchInput } from "~/components/logs/LogsSearchInput";
import { LogsTaskFilter } from "~/components/logs/LogsTaskFilter";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { Button } from "~/components/primitives/Buttons";
import { Badge } from "~/components/primitives/Badge";
import { Header1, Header3 } from "~/components/primitives/Headers";
import { formatDistanceToNow } from "date-fns";
import { cn } from "~/utils/cn";
import {
  CopyableTableCell,
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";

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

  // Get filters from query params
  const url = new URL(request.url);
  const tasks = url.searchParams.getAll("tasks").filter((t) => t.length > 0);
  const search = url.searchParams.get("search") ?? undefined;
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;

  // Get the user's plan to determine retention limit
  const plan = await getCurrentPlan(project.organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  const presenter = new ErrorsListPresenter($replica, logsClickhouseClient);

  const listPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: tasks.length > 0 ? tasks : undefined,
      search,
      period,
      from,
      to,
      defaultPeriod: "7d",
      retentionLimitDays,
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  return typeddefer({
    data: listPromise,
    defaultPeriod: "7d",
    retentionLimitDays,
    organizationSlug,
    projectParam,
    envParam,
  });
};

export default function Page() {
  const { data, defaultPeriod, retentionLimitDays, organizationSlug, projectParam, envParam } =
    useTypedLoaderData<typeof loader>();

  return (
    <>
      <PageContainer>
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
                  <FiltersBar
                    defaultPeriod={defaultPeriod}
                    retentionLimitDays={retentionLimitDays}
                  />
                  <div className="flex items-center justify-center px-3 py-12">
                    <Callout variant="error" className="max-w-fit">
                      Unable to load errors. Please refresh the page or try again in a moment.
                    </Callout>
                  </div>
                </div>
              }
            >
              {(result) => {
                // Check if result contains an error
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
      </PageContainer>
      <Outlet />
    </>
  );
}

function FiltersBar({
  list,
  defaultPeriod,
  retentionLimitDays,
}: {
  list?: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>;
  defaultPeriod?: string;
  retentionLimitDays: number;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("tasks") ||
    searchParams.has("search") ||
    searchParams.has("period") ||
    searchParams.has("from") ||
    searchParams.has("to");

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-1">
        {list ? (
          <>
            <LogsTaskFilter possibleTasks={list.filters.possibleTasks} />
            <TimeFilter defaultPeriod={defaultPeriod} maxPeriodDays={retentionLimitDays} />
            <LogsSearchInput placeholder="Search errors..." />
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
            <LogsTaskFilter possibleTasks={[]} />
            <TimeFilter defaultPeriod={defaultPeriod} maxPeriodDays={retentionLimitDays} />
            <LogsSearchInput placeholder="Search errors..." />
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
    </div>
  );
}

function ErrorsList({
  errorGroups,
  organizationSlug,
  projectParam,
  envParam,
}: {
  errorGroups: ErrorGroup[];
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
          <TableHeaderCell>Error</TableHeaderCell>
          <TableHeaderCell>Occurrences</TableHeaderCell>
          <TableHeaderCell>Tasks</TableHeaderCell>
          <TableHeaderCell>First seen</TableHeaderCell>
          <TableHeaderCell>Last seen</TableHeaderCell>
          <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {errorGroups.map((errorGroup) => (
          <ErrorGroupRow
            key={errorGroup.fingerprint}
            errorGroup={errorGroup}
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
  organizationSlug,
  projectParam,
  envParam,
}: {
  errorGroup: ErrorGroup;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
}) {
  const errorPath = v3ErrorPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
    { fingerprint: errorGroup.fingerprint }
  );

  const errorMessage = `${errorGroup.errorType}: ${errorGroup.errorMessage}`;

  return (
    <TableRow>
      <CopyableTableCell to={errorPath} value={errorGroup.fingerprint}>
        {errorGroup.fingerprint.slice(-8)}
      </CopyableTableCell>
      <CopyableTableCell to={errorPath} className="font-mono" value={errorMessage}>
        {errorMessage}
      </CopyableTableCell>
      <TableCell to={errorPath}>{errorGroup.count.toLocaleString()}</TableCell>
      <TableCell to={errorPath}>{errorGroup.affectedTasks}</TableCell>
      <TableCell to={errorPath}>
        {formatDistanceToNow(errorGroup.firstSeen, { addSuffix: true })}
      </TableCell>
      <TableCell to={errorPath}>
        {formatDistanceToNow(errorGroup.lastSeen, { addSuffix: true })}
      </TableCell>
      <TableCellChevron to={errorPath} isSticky />
    </TableRow>
  );
}
