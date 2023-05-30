import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { environmentTitle } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2, Header3 } from "~/components/primitives/Headers";
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
import { RunStatusIcon, runStatusTitle } from "~/components/runs/RunStatuses";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  formatDateTime,
  formatDuration,
  formatDurationMilliseconds,
} from "~/utils";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { jobPath } from "~/utils/pathBuilder";
import {
  RunPanel,
  RunPanelBody,
  RunPanelDescription,
  RunPanelElements,
  RunPanelHeader,
  RunPanelIconElement,
  RunPanelIconSection,
  RunPanelIconTitle,
  TaskSeparator,
} from "./RunCard";
import { TaskStatusIcon } from "./TaskStatus";
import { Fragment, useCallback, useMemo, useState } from "react";
import { Detail } from "./DetailView";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, runParam } = params;
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

  return typedjson({
    run,
  });
};

//todo breadcrumb
export const handle: Handle = {
  // breadcrumb: {
  // slug: "run",
  // },
};

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    run.tasks[0]?.id
  );
  const selectedItem = useMemo(() => {
    if (!selectedId) return undefined;
    if (selectedId === run.event.id)
      return { type: "event" as const, event: run.event };
    const task = run.tasks.find((task) => task.id === selectedId);
    if (task) return { type: "task" as const, task };
  }, [selectedId, run]);

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
          <div className="overflow-y-auto py-4 pl-4">
            <Header2 className="mb-2">Tasks</Header2>
            {run.tasks.map((task, index) => {
              const isSelected = task.id === selectedId;
              const isLast = index === run.tasks.length - 1;
              const connection = run.runConnections.find(
                (c) => c.key === task.connectionKey
              );
              return (
                <Fragment key={task.id}>
                  <RunPanel
                    selected={isSelected}
                    onClick={() => setSelectedId(task.id)}
                  >
                    <RunPanelHeader
                      icon={
                        <TaskStatusIcon
                          status={task.status}
                          minimal={true}
                          className={cn(
                            "h-5 w-5",
                            !isSelected && "text-slate-400"
                          )}
                        />
                      }
                      title={
                        <RunPanelIconTitle icon={task.icon} title={task.name} />
                      }
                      accessory={
                        <Paragraph variant="extra-small">
                          {formatDuration(task.startedAt, task.completedAt, {
                            style: "short",
                          })}
                        </Paragraph>
                      }
                    />
                    <RunPanelBody>
                      {task.description && (
                        <RunPanelDescription text={task.description} />
                      )}
                      <RunPanelIconSection>
                        {task.displayKey && (
                          <RunPanelIconElement
                            icon="key"
                            label="Key"
                            value={task.displayKey}
                          />
                        )}
                        {connection && (
                          <RunPanelIconElement
                            icon={
                              connection.apiConnection.client
                                .integrationIdentifier
                            }
                            label="Connection"
                            value={connection.apiConnection.client.title}
                          />
                        )}
                      </RunPanelIconSection>
                      {task.elements.length > 0 && (
                        <RunPanelElements
                          elements={task.elements.map((element) => ({
                            label: element.label,
                            value: element.text,
                          }))}
                          className="mt-4"
                        />
                      )}
                    </RunPanelBody>
                  </RunPanel>
                  {!isLast && <TaskSeparator />}
                </Fragment>
              );
            })}
          </div>
          {/* Detail view */}
          <div className="overflow-y-auto py-4 pr-4">
            <Header2 className="mb-2">Detail</Header2>
            {!selectedItem ? (
              <RunPanel selected={false} className="h-full">
                <Paragraph variant="base" className="p-4">
                  Nothing selected
                </Paragraph>
              </RunPanel>
            ) : (
              <Detail {...selectedItem} />
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
