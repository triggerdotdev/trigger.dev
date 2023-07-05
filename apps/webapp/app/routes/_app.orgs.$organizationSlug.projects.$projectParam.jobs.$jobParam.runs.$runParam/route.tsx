import { conform } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BoltIcon, ForwardIcon } from "@heroicons/react/24/solid";
import { Form, Outlet, useNavigate, useRevalidator } from "@remix-run/react";
import { ActionFunction, LoaderArgs, json } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/internal";
import { useEffect, useMemo } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives/Popover";
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
import {
  redirectBackWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { ContinueRunService } from "~/services/runs/continueRun.server";
import { ReRunService } from "~/services/runs/reRun.server";
import { requireUserId } from "~/services/session.server";
import { formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  RunParamsSchema,
  jobPath,
  runCompletedPath,
  runDashboardPath,
  runStreamingPath,
  runTaskPath,
  runTriggerPath,
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
  const { runParam } = RunParamsSchema.parse(params);

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

  return typedjson({
    run,
  });
};

const schema = z.object({});

export const action: ActionFunction = async ({ request, params }) => {
  const { organizationSlug, projectParam, jobParam, runParam } =
    RunParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    if (submission.intent === "start") {
      const rerunService = new ReRunService();
      const run = await rerunService.call({ runId: runParam });

      if (!run) {
        return redirectBackWithErrorMessage(request, "Unable to retry run");
      }

      return redirectWithSuccessMessage(
        runDashboardPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: jobParam },
          { id: run.id }
        ),
        request,
        `Created new run`
      );
    } else if (submission.intent === "continue") {
      const continueService = new ContinueRunService();
      await continueService.call({ runId: runParam });

      return redirectWithSuccessMessage(
        runDashboardPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: jobParam },
          { id: runParam }
        ),
        request,
        `Resuming run`
      );
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export const handle: Handle = {
  breadcrumb: {
    slug: "run",
  },
};

const taskPattern = /\/tasks\/(.*)/;

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const navigate = useNavigate();

  const pathName = usePathName();

  const selectedId = useMemo(() => {
    if (pathName.endsWith("/completed")) {
      return "completed";
    }

    if (pathName.endsWith("/trigger")) {
      return "trigger";
    }

    const taskMatch = pathName.match(taskPattern);
    const taskId = taskMatch ? taskMatch[1] : undefined;
    if (taskId) {
      return taskId;
    }
  }, [pathName]);

  const basicStatus = runBasicStatus(run.status);

  const revalidator = useRevalidator();
  const events = useEventSource(
    runStreamingPath(organization, project, job, run),
    {
      event: "message",
    }
  );
  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

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
            <RerunPopover
              environmentType={run.environment.type}
              status={basicStatus}
            />
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
                run.startedAt ? (
                  <DateTime date={run.startedAt} />
                ) : (
                  "Not started yet"
                )
              }
            />
            <PageInfoProperty
              icon={"property"}
              label={"Version"}
              value={`v${run.version}`}
            />
            <PageInfoProperty
              label={"Env"}
              value={<EnvironmentLabel environment={run.environment} />}
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
        <div className="grid h-full grid-cols-2 gap-2">
          <div className="flex flex-col gap-6 overflow-y-auto py-4 pl-4 pr-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
            <div>
              <Header2 className="mb-2">Trigger</Header2>
              <RunPanel
                selected={selectedId === "trigger"}
                onClick={() =>
                  navigate(runTriggerPath(organization, project, job, run))
                }
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
                  <RunPanelProperties
                    properties={[
                      { label: "Event name", text: run.event.name },
                      ...run.properties,
                    ]}
                  />
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
                      selectedTask={(taskId) => {
                        navigate(
                          runTaskPath(organization, project, job, run, taskId)
                        );
                      }}
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
                  onClick={() =>
                    navigate(runCompletedPath(organization, project, job, run))
                  }
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
                          value={<DateTime date={run.startedAt} />}
                        />
                      )}
                      {run.completedAt && (
                        <RunPanelIconProperty
                          icon="flag"
                          label="Finished at"
                          value={<DateTime date={run.completedAt} />}
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
                      <CodeBlock
                        language="json"
                        code={run.output}
                        maxLines={10}
                      />
                    ) : (
                      run.output === null && (
                        <Paragraph variant="small">
                          This Run returned nothing.
                        </Paragraph>
                      )
                    )}
                  </RunPanelBody>
                </RunPanel>
              </div>
            )}
          </div>

          {/* Detail view */}
          <div className="overflow-y-auto py-4 pr-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
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
      return (
        <div>
          <Paragraph variant="small" className="mb-4">
            Waiting for tasks…
          </Paragraph>
          <TaskCardSkeleton />
        </div>
      );
    default:
      return (
        <Paragraph variant="small">There were no tasks for this run.</Paragraph>
      );
  }
}

function RerunPopover({
  environmentType,
  status,
}: {
  environmentType: RuntimeEnvironmentType;
  status: RunBasicStatus;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild={true}>
        <Button variant="primary/small" shortcut={{ key: "R" }}>
          Rerun Job
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-2 p-4" align="end">
        <Form method="post">
          {environmentType === "PRODUCTION" && (
            <Callout variant="warning">
              This will rerun this Job in your Production environment.
            </Callout>
          )}

          <div className="flex flex-col items-start gap-4 divide-y divide-slate-600">
            <div>
              <Button
                variant="primary/small"
                type="submit"
                name={conform.INTENT}
                value="start"
                fullWidth
                LeadingIcon={BoltIcon}
              >
                Run again
              </Button>

              <Paragraph variant="extra-small" className="mt-2">
                Start a brand new job run with the same Trigger data as this
                one. This will re-do every task.
              </Paragraph>
            </div>
            {status === "FAILED" && (
              <div className="pt-4">
                <Button
                  variant="primary/small"
                  type="submit"
                  name={conform.INTENT}
                  value="continue"
                  fullWidth
                  LeadingIcon={ForwardIcon}
                >
                  Retry job run
                </Button>

                <Paragraph variant="extra-small" className="mt-2">
                  Continue running this job run from where it left off. This
                  will skip any task that has already been completed.
                </Paragraph>
              </div>
            )}
          </div>
        </Form>
      </PopoverContent>
    </Popover>
  );
}
