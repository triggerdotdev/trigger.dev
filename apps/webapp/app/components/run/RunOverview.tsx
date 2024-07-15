import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { PlayIcon } from "@heroicons/react/20/solid";
import { BoltIcon } from "@heroicons/react/24/solid";
import {
  Form,
  Outlet,
  useActionData,
  useLocation,
  useNavigate,
  useNavigation,
} from "@remix-run/react";
import { type RuntimeEnvironmentType, type User } from "@trigger.dev/database";
import { useMemo } from "react";
import { usePathName } from "~/hooks/usePathName";
import type { RunBasicStatus } from "~/models/jobRun.server";
import { type ViewRun } from "~/presenters/RunPresenter.server";
import { cancelSchema } from "~/routes/resources.runs.$runId.cancel";
import { schema } from "~/routes/resources.runs.$runId.rerun";
import { cn } from "~/utils/cn";
import { runCompletedPath, runTaskPath, runTriggerPath } from "~/utils/pathBuilder";
import { CodeBlock } from "../code/CodeBlock";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { PageBody, PageContainer } from "../layout/AppLayout";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { DateTime } from "../primitives/DateTime";
import { Header2 } from "../primitives/Headers";
import { Icon } from "../primitives/Icon";
import { NamedIcon } from "../primitives/NamedIcon";
import {
  PageAccessories,
  NavBar,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
} from "../primitives/PageHeader";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { RunStatusIcon, RunStatusLabel, runStatusTitle } from "../runs/RunStatuses";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDivider,
  RunPanelError,
  RunPanelHeader,
  RunPanelIconProperty,
  RunPanelIconSection,
  RunPanelProperties,
} from "./RunCard";
import { TaskCard } from "./TaskCard";
import { TaskCardSkeleton } from "./TaskCardSkeleton";
import { formatDuration, formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";

type RunOverviewProps = {
  run: ViewRun;
  trigger: {
    icon: string;
    title: string;
  };
  showRerun: boolean;
  paths: {
    back: string;
    run: string;
    runsPath: string;
  };
  currentUser: User;
};

const taskPattern = /\/tasks\/(.*)/;

export function RunOverview({ run, trigger, showRerun, paths, currentUser }: RunOverviewProps) {
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

  const usernameForEnv =
    currentUser.id !== run.environment.userId ? run.environment.userName : undefined;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          backButton={{
            to: paths.back,
            text: "Runs",
          }}
          title={
            typeof run.number === "number" ? `Run #${run.number}` : `Run ${run.id.slice(0, 8)}`
          }
        />
        <PageAccessories>
          {run.isTest && (
            <span className="flex items-center gap-1 text-xs uppercase text-charcoal-600">
              <NamedIcon name="beaker" className="h-4 w-4 text-charcoal-600" />
              Test run
            </span>
          )}
          {showRerun && run.isFinished && (
            <RerunPopover
              runId={run.id}
              runPath={paths.run}
              runsPath={paths.runsPath}
              environmentType={run.environment.type}
              status={run.basicStatus}
            />
          )}
          {!run.isFinished && <CancelRun runId={run.id} />}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false} className="grid grid-rows-[auto_1fr] overflow-hidden">
        <div className="border-b border-grid-dimmed px-4 py-4">
          <PageInfoRow className="overflow-hidden">
            <PageInfoGroup>
              <PageInfoProperty
                icon={<RunStatusIcon status={run.status} className="h-4 w-4" />}
                label={"Status"}
                value={runStatusTitle(run.status)}
              />
              <PageInfoProperty
                icon={"calendar"}
                label={"Started"}
                value={run.startedAt ? <DateTime date={run.startedAt} /> : "Not started yet"}
              />
              <PageInfoProperty icon={"property"} label={"Version"} value={`v${run.version}`} />
              <PageInfoProperty
                label={"Env"}
                value={<EnvironmentLabel environment={run.environment} userName={usernameForEnv} />}
              />
              <PageInfoProperty
                icon={"clock"}
                label={"Duration"}
                value={formatDuration(run.startedAt, run.completedAt, { style: "short" })}
              />
              <PageInfoProperty
                icon={<Icon icon="alarm-filled" className="h-4 w-4 text-blue-500" />}
                label={"Execution Time"}
                value={formatDurationMilliseconds(run.executionDuration, { style: "short" })}
              />
              <PageInfoProperty
                icon={<Icon icon="list-numbers" className="h-4 w-4 text-yellow-500" />}
                label={"Execution Count"}
                value={<>{run.executionCount}</>}
              />
            </PageInfoGroup>
            <PageInfoGroup alignment="right">
              <Paragraph variant="extra-small" className="whitespace-nowrap text-charcoal-600">
                RUN ID: {run.id}
              </Paragraph>
            </PageInfoGroup>
          </PageInfoRow>
        </div>
        <div className="grid h-full grid-cols-2 gap-2 overflow-hidden">
          <div className="flex flex-col gap-6 overflow-y-auto py-4 pl-4 pr-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <div>
              {run.status === "SUCCESS" &&
                (run.tasks.length === 0 || run.tasks.every((t) => t.noop)) && (
                  <Callout
                    variant={"warning"}
                    to="https://trigger.dev/docs/documentation/concepts/tasks"
                    className="mb-4"
                  >
                    This Run completed but it did not use any Tasks – this can cause unpredictable
                    results. Read the docs to view the solution.
                  </Callout>
                )}
              <Header2 className="mb-2">Trigger</Header2>
              <RunPanel
                selected={selectedId === "trigger"}
                onClick={() => navigate(runTriggerPath(paths.run))}
              >
                <RunPanelHeader icon={trigger.icon} title={trigger.title} />
                <RunPanelBody>
                  <RunPanelProperties
                    properties={[{ label: "Event name", text: run.event.name }]
                      .concat(
                        run.event.externalAccount
                          ? [{ label: "Account ID", text: run.event.externalAccount.identifier }]
                          : []
                      )
                      .concat(run.properties)}
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
                        navigate(runTaskPath(paths.run, taskId));
                      }}
                      isLast={isLast}
                      depth={0}
                      {...task}
                    />
                  );
                })
              ) : (
                <BlankTasks status={run.basicStatus} />
              )}
            </div>
            {(run.basicStatus === "COMPLETED" || run.basicStatus === "FAILED") && (
              <div>
                <Header2 className={cn("mb-2")}>Run Summary</Header2>
                <RunPanel
                  selected={selectedId === "completed"}
                  onClick={() => navigate(runCompletedPath(paths.run))}
                >
                  <RunPanelHeader
                    icon={<RunStatusIcon status={run.status} className={"h-5 w-5"} />}
                    title={
                      <Paragraph variant="small/bright">
                        <RunStatusLabel status={run.status} />
                      </Paragraph>
                    }
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
                          value={formatDuration(run.startedAt, run.completedAt, {
                            style: "long",
                          })}
                        />
                      )}
                    </RunPanelIconSection>
                    <RunPanelDivider />
                    {run.error && (
                      <RunPanelError text={run.error.message} stackTrace={run.error.stack} />
                    )}
                    {run.output ? (
                      <CodeBlock language="json" code={run.output} maxLines={10} />
                    ) : (
                      run.output === null && (
                        <Paragraph variant="small" className="mt-4">
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
          <div className="overflow-y-auto py-4 pr-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <Header2 className="mb-2">Details</Header2>
            {selectedId ? <Outlet /> : <Callout variant="info">Select a task or trigger</Callout>}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function BlankTasks({ status }: { status: RunBasicStatus }) {
  switch (status) {
    default:
    case "COMPLETED":
      return <Paragraph variant="small">There were no tasks for this run.</Paragraph>;
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
  }
}

function RerunPopover({
  runId,
  runPath,
  runsPath,
  environmentType,
  status,
}: {
  runId: string;
  runPath: string;
  runsPath: string;
  environmentType: RuntimeEnvironmentType;
  status: RunBasicStatus;
}) {
  const lastSubmission = useActionData();

  const [form, { successRedirect, failureRedirect }] = useForm({
    id: "rerun",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <Popover>
      <PopoverTrigger asChild={true}>
        <Button variant="primary/small" shortcut={{ key: "R" }}>
          Rerun Job
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex min-w-[20rem] max-w-[20rem] flex-col gap-2 p-0" align="end">
        <Form method="post" action={`/resources/runs/${runId}/rerun`} {...form.props}>
          <input {...conform.input(successRedirect, { type: "hidden" })} defaultValue={runsPath} />
          <input {...conform.input(failureRedirect, { type: "hidden" })} defaultValue={runPath} />
          {environmentType === "PRODUCTION" && (
            <div className="px-4 pt-4">
              <Callout variant="warning">
                This will rerun this Job in your Production environment.
              </Callout>
            </div>
          )}

          <div className="flex flex-col items-start divide-y divide-charcoal-800">
            <div className="p-4">
              <Paragraph variant="small" className="mb-3">
                Start a brand new Job run with the same Trigger data as this one. This will re-do
                every Task.
              </Paragraph>
              <Button
                variant="secondary/medium"
                type="submit"
                name={conform.INTENT}
                value="start"
                fullWidth
                className="text-text-bright"
              >
                <BoltIcon className="mr-1 h-3.5 w-3.5 text-text-bright" />
                Run again
              </Button>
            </div>
            {status === "FAILED" && (
              <div className="p-4">
                <Paragraph variant="small" className="mb-3">
                  Continue running this Job run from where it left off. This will skip any Task that
                  has already been completed.
                </Paragraph>
                <Button
                  variant="secondary/medium"
                  type="submit"
                  name={conform.INTENT}
                  value="continue"
                  fullWidth
                  className="text-text-bright"
                >
                  <PlayIcon className="mr-1 h-3.5 w-3.5 text-text-bright" />
                  Retry Job run
                </Button>
              </div>
            )}
          </div>
        </Form>
      </PopoverContent>
    </Popover>
  );
}

export function CancelRun({ runId }: { runId: string }) {
  const lastSubmission = useActionData();
  const location = useLocation();
  const navigation = useNavigation();

  const [form, { redirectUrl }] = useForm({
    id: "cancel-run",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: cancelSchema });
    },
  });

  const isLoading = navigation.state === "submitting" && navigation.formData !== undefined;

  return (
    <Form method="post" action={`/resources/runs/${runId}/cancel`} {...form.props}>
      <input {...conform.input(redirectUrl, { type: "hidden" })} defaultValue={location.pathname} />
      <Button
        type="submit"
        LeadingIcon={isLoading ? "spinner-white" : "stop"}
        leadingIconClassName="text-white"
        variant="danger/small"
        disabled={isLoading}
      >
        {isLoading ? "Canceling" : "Cancel run"}
      </Button>
    </Form>
  );
}
