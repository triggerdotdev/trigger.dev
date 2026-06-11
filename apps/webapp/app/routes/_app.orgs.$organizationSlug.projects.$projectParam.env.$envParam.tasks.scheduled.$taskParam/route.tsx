import { BeakerIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense, useMemo } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import {
  ScheduleTypeIcon,
  scheduleTypeName,
} from "~/components/runs/v3/ScheduleType";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import {
  TaskDetailPresenter,
  type TaskDetail,
} from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3CreateBulkActionPath,
  v3EnvironmentPath,
  v3RunsPath,
  v3SchedulePath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const slug = (data as { task?: TaskDetail | null } | undefined)?.task?.slug;
  return [{ title: slug ? `${slug} | Scheduled tasks | Trigger.dev` : "Scheduled task | Trigger.dev" }];
};

const ParamsSchema = EnvironmentParamSchema.extend({
  taskParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, taskParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction") ?? undefined;
  const direction = directionRaw ? DirectionSchema.parse(directionRaw) : undefined;

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );

  const taskPresenter = new TaskDetailPresenter($replica, clickhouse);
  const task = await taskPresenter.findTask({
    environmentId: environment.id,
    environmentType: environment.type,
    taskSlug: taskParam,
    expectedTriggerSource: "SCHEDULED",
  });

  if (!task) throw new Response("Scheduled task not found", { status: 404 });

  const pageRaw = parseInt(url.searchParams.get("page") ?? "1", 10);
  const schedulesPage = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const scheduleList = new ScheduleListPresenter()
    .call({
      userId,
      projectId: project.id,
      environmentId: environment.id,
      tasks: [task.slug],
      page: schedulesPage,
    })
    .catch(() => null);

  const runList = new NextRunListPresenter($replica, clickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [task.slug],
      period,
      from,
      to,
      cursor,
      direction,
    })
    .catch(() => null);

  return typeddefer({
    task,
    scheduleList,
    runList,
  });
};

export default function Page() {
  const { task, scheduleList, runList } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const scheduledTasksListingPath = v3EnvironmentPath(organization, project, environment);
  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });

  const filters: TaskRunListSearchFilters = useMemo(
    () => ({ tasks: [task.slug] }),
    [task.slug]
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          backButton={{ to: scheduledTasksListingPath, text: "Scheduled tasks" }}
          title={
            <span className="flex items-center gap-2">
              <ClockIcon className="size-4 text-schedules" />
              <span>{task.slug}</span>
            </span>
          }
        />
        <PageAccessories>
          <LinkButton
            variant="secondary/small"
            to={testPath}
            LeadingIcon={BeakerIcon}
            leadingIconClassName="text-tests"
          >
            Test scheduled task
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="vertical" className="max-h-full">
          {/* Top half: schedules table */}
          <ResizablePanel id="scheduled-task-schedules" min="120px" default="40%">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              <div className="flex items-center justify-between border-b border-grid-dimmed px-3 py-2">
                <Header3>Schedules</Header3>
                <Suspense fallback={null}>
                  <TypedAwait resolve={scheduleList}>
                    {(list) =>
                      list ? (
                        <span className="text-xs tabular-nums text-text-dimmed">
                          {list.totalCount} total
                        </span>
                      ) : null
                    }
                  </TypedAwait>
                </Suspense>
              </div>
              <div className="overflow-y-auto">
                <Suspense fallback={<TableLoading />}>
                  <TypedAwait resolve={scheduleList} errorElement={<TableLoading />}>
                    {(list) =>
                      list ? <SchedulesMiniTable schedules={list.schedules} /> : <TableLoading />
                    }
                  </TypedAwait>
                </Suspense>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle id="scheduled-task-handle" />

          {/* Bottom half: runs */}
          <ResizablePanel id="scheduled-task-runs" min="120px">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              <div className="flex items-center justify-between border-b border-grid-dimmed px-3 py-2">
                <Header3>Runs</Header3>
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
                  <Suspense fallback={null}>
                    <TypedAwait resolve={runList}>
                      {(list) => (list ? <ListPagination list={list} /> : null)}
                    </TypedAwait>
                  </Suspense>
                </div>
              </div>
              <div className="overflow-y-auto">
                <Suspense fallback={<TableLoading />}>
                  <TypedAwait resolve={runList} errorElement={<TableLoading />}>
                    {(list) =>
                      list ? (
                        <TaskRunsTable
                          total={list.runs.length}
                          hasFilters={list.hasFilters}
                          filters={list.filters}
                          runs={list.runs}
                          variant="dimmed"
                        />
                      ) : (
                        <TableLoading />
                      )
                    }
                  </TypedAwait>
                </Suspense>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

type ScheduleRow = {
  id: string;
  friendlyId: string;
  type: "DECLARATIVE" | "IMPERATIVE";
  cron: string;
  cronDescription: string;
  externalId: string | null;
  nextRun: Date;
  lastRun: Date | undefined;
  active: boolean;
};

function SchedulesMiniTable({ schedules }: { schedules: ScheduleRow[] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (schedules.length === 0) {
    return (
      <Table>
        <TableBody>
          <TableBlankRow colSpan={6}>
            <Paragraph variant="small" className="flex items-center justify-center">
              No schedules attached to this task yet.
            </Paragraph>
          </TableBlankRow>
        </TableBody>
      </Table>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Schedule ID</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Cron</TableHeaderCell>
          <TableHeaderCell>External ID</TableHeaderCell>
          <TableHeaderCell>Next run</TableHeaderCell>
          <TableHeaderCell>Last run</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.map((schedule) => {
          const inspectorPath = v3SchedulePath(organization, project, environment, {
            friendlyId: schedule.friendlyId,
          });
          return (
            <TableRow key={schedule.id} className="group">
              <TableCell to={inspectorPath} isTabbableCell>
                <span className="font-mono text-xs">{schedule.friendlyId}</span>
              </TableCell>
              <TableCell to={inspectorPath}>
                <span className="inline-flex items-center gap-1 text-xs text-text-dimmed">
                  <ScheduleTypeIcon
                    type={schedule.type}
                    className={
                      schedule.type === "DECLARATIVE" ? "text-sky-500" : "text-teal-500"
                    }
                  />
                  {scheduleTypeName(schedule.type)}
                </span>
              </TableCell>
              <TableCell to={inspectorPath}>
                <span className="font-mono text-xs">{schedule.cron}</span>
              </TableCell>
              <TableCell to={inspectorPath}>
                {schedule.externalId ? (
                  <span className="font-mono text-xs">{schedule.externalId}</span>
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </TableCell>
              <TableCell to={inspectorPath}>
                <RelativeDateTime date={schedule.nextRun} />
              </TableCell>
              <TableCell to={inspectorPath}>
                {schedule.lastRun ? (
                  <RelativeDateTime date={schedule.lastRun} />
                ) : (
                  <span className="text-text-dimmed">Never</span>
                )}
              </TableCell>
              <TableCell to={inspectorPath}>
                <EnabledStatus enabled={schedule.active} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function TableLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}
