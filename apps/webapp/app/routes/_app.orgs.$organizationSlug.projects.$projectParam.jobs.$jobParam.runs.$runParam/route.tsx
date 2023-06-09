import { BoltIcon } from "@heroicons/react/24/solid";
import { Outlet, useNavigate } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { useCallback, useMemo } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CodeBlock } from "~/components/code/CodeBlock";
import { environmentTitle } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageButtons,
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  RunBasicStatus,
  RunStatusIcon,
  RunStatusLabel,
  runBasicStatus,
  runStatusTitle,
} from "~/components/runs/RunStatuses";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { JobRunStatus } from "~/models/job.server";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime, formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  runEventPath,
  jobPath,
  runTaskPath,
  runCompletedPath,
} from "~/utils/pathBuilder";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelError,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelIconTitle,
  RunPanelProperties,
} from "./RunCard";
import { TaskCard } from "./TaskCard";
import { TaskCardSkeleton } from "./TaskCardSkeleton";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const {
    organizationSlug,
    projectParam,
    jobParam,
    runParam,
    eventParam,
    taskParam,
  } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(projectParam, "projectParam not found");
  invariant(jobParam, "jobParam not found");
  invariant(runParam, "runParam not found");

  const presenter = new RunPresenter();
  const run = await presenter.call({
    userId,
    id: runParam,
  });

  if (!run) {
    throw new Response(null, {
      status: 404,
    });
  }

  //redirect to the event if no event or task is selected
  if (!eventParam && !taskParam) {
    return redirect(
      runEventPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { id: jobParam },
        { id: runParam },
        run.event.id
      )
    );
  }

  return typedjson({
    run,
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "run",
  },
};

const taskPattern = /\/tasks\/(.*)/;
const eventPattern = /\/events\/(.*)/;

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const navigate = useNavigate();

  const selectedTask = useCallback((id: string) => {
    navigate(runTaskPath(organization, project, job, run, id));
  }, []);

  const selectedEvent = useCallback((id: string) => {
    navigate(runEventPath(organization, project, job, run, id));
  }, []);

  const selectedCompleted = useCallback(() => {
    navigate(runCompletedPath(organization, project, job, run));
  }, []);

  const pathName = usePathName();

  const selectedId = useMemo(() => {
    if (pathName.endsWith("/completed")) {
      return "completed";
    }

    const taskMatch = pathName.match(taskPattern);
    const taskId = taskMatch ? taskMatch[1] : undefined;
    if (taskId) {
      return taskId;
    }

    const eventMatch = pathName.match(eventPattern);
    const eventId = eventMatch ? eventMatch[1] : undefined;
    return eventId;
  }, [pathName]);

  const basicStatus = runBasicStatus(run.status);

  console.log(run);

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle
            backButton={{
              to: jobPath(organization, project, job),
              text: "Runs",
            }}
            title={`Run #${run.number}`}
          />
          <PageButtons>
            {run.isTest && (
              <span className="flex items-center gap-1 text-xs uppercase text-slate-600">
                <NamedIcon name="beaker" className="h-4 w-4 text-slate-600" />
                Test run
              </span>
            )}
            {/*  //todo rerun
            <LinkButton
              to={jobTestPath(organization, project, job)}
              variant="primary/small"
              shortcut="T"
            >
              Rerun Job
            </LinkButton> */}
          </PageButtons>
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={<RunStatusIcon status={run.status} className="h-4 w-4" />}
              label={"Status"}
              value={runStatusTitle(run.status)}
            />
            <PageInfoProperty
              icon={"calendar"}
              label={"Started"}
              value={
                run.startedAt
                  ? formatDateTime(run.startedAt)
                  : "Not started yet"
              }
            />
            <PageInfoProperty
              icon={"property"}
              label={"Version"}
              value={`v${run.version}`}
            />
            <PageInfoProperty
              icon={"environment"}
              label={"Env"}
              value={environmentTitle(run.environment)}
            />
            <PageInfoProperty
              icon={"clock"}
              label={"Duration"}
              value={formatDuration(run.startedAt, run.completedAt)}
            />
          </PageInfoGroup>
          <PageInfoGroup alignment="right">
            <Paragraph variant="extra-small" className="text-slate-600">
              RUN ID: {run.id}
            </Paragraph>
          </PageInfoGroup>
        </PageInfoRow>
      </PageHeader>
      <PageBody scrollable={false}>
        <div className="grid h-full grid-cols-2 gap-4">
          <div className="flex flex-col gap-6 overflow-y-auto py-4 pl-4">
            <div>
              <Header2 className="mb-2">Trigger</Header2>
              <RunPanel
                selected={run.event.id === selectedId}
                onClick={() => selectedEvent(run.event.id)}
              >
                <RunPanelHeader
                  icon={<BoltIcon className="h-5 w-5 text-orange-500" />}
                  title={
                    <RunPanelIconTitle
                      icon={job.event.icon}
                      title={job.event.title}
                    />
                  }
                />
                <RunPanelBody>
                  {/* <RunPanelIconSection>
                  {connection && (
                    <RunPanelIconProperty
                      icon={
                        connection.apiConnection.client.integrationIdentifier
                      }
                      label="Connection"
                      value={connection.apiConnection.client.title}
                    />
                  )}
                </RunPanelIconSection>*/}
                  {run.properties.length > 0 && (
                    <RunPanelProperties properties={run.properties} />
                  )}
                </RunPanelBody>
              </RunPanel>
            </div>
            <div>
              <Header2 className="mb-2">Tasks</Header2>

              {run.tasks.length > 0 ? (
                run.tasks.map((task, index) => {
                  const isLast = index === run.tasks.length - 1;

                  return (
                    <TaskCard
                      key={task.id}
                      selectedId={selectedId}
                      selectedTask={selectedTask}
                      isLast={isLast}
                      depth={0}
                      {...task}
                    />
                  );
                })
              ) : (
                <BlankTasks status={run.status} basicStatus={basicStatus} />
              )}
            </div>
            {(basicStatus === "COMPLETED" || basicStatus === "FAILED") && (
              <div>
                <Header2 className={cn("mb-2")}>Run Summary</Header2>
                <RunPanel
                  selected={selectedId === "completed"}
                  onClick={() => selectedCompleted()}
                >
                  <RunPanelHeader
                    icon={
                      <RunStatusIcon
                        status={run.status}
                        className={"h-5 w-5"}
                      />
                    }
                    title={<RunStatusLabel status={run.status} />}
                  />
                  <RunPanelBody>
                    <RunPanelIconSection>
                      {run.startedAt && (
                        <RunPanelIconProperty
                          icon="calendar"
                          label="Started at"
                          value={formatDateTime(run.startedAt, "long")}
                        />
                      )}
                      {run.completedAt && (
                        <RunPanelIconProperty
                          icon="flag"
                          label="Finished at"
                          value={formatDateTime(run.completedAt, "long")}
                        />
                      )}
                      {run.startedAt && run.completedAt && (
                        <RunPanelIconProperty
                          icon="clock"
                          label="Total duration"
                          value={formatDuration(
                            run.startedAt,
                            run.completedAt,
                            {
                              style: "long",
                            }
                          )}
                        />
                      )}
                    </RunPanelIconSection>
                    <RunPanelDivider />
                    {run.error && (
                      <RunPanelError
                        text={run.error.message}
                        stackTrace={run.error.stack}
                      />
                    )}
                    {run.output ? (
                      <CodeBlock language="json" code={run.output} />
                    ) : (
                      run.output === null && (
                        <Paragraph variant="small">
                          This run returned nothing
                        </Paragraph>
                      )
                    )}
                  </RunPanelBody>
                </RunPanel>
              </div>
            )}
          </div>

          {/* Detail view */}
          <div className="overflow-y-auto py-4 pr-4">
            <Header2 className="mb-2">Detail</Header2>
            {selectedId ? (
              <Outlet />
            ) : (
              <Callout variant="info">Select a task or trigger</Callout>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function BlankTasks({
  status,
  basicStatus,
}: {
  status: JobRunStatus;
  basicStatus: RunBasicStatus;
}) {
  switch (basicStatus) {
    case "COMPLETED":
      return (
        <Paragraph variant="small">There were no tasks for this run.</Paragraph>
      );
    case "FAILED":
      return <Paragraph variant="small">No tasks were run.</Paragraph>;
    case "WAITING":
    case "PENDING":
    case "RUNNING":
      return <TaskCardSkeleton />;
    default:
      return (
        <Paragraph variant="small">There were no tasks for this run.</Paragraph>
      );
  }
}
