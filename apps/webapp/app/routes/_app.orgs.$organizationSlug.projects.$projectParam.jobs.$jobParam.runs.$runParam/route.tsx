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
  RunPanelElements,
  RunPanelHeader,
  RunPanelIconElement,
  RunPanelIconSection,
  TaskSeparator,
} from "./RunCard";
import { TaskStatusIcon } from "./TaskStatus";
import { Fragment, useState } from "react";

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
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

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
      <PageBody>
        <div className="grid grid-cols-2 gap-4">
          <div>
            {run.tasks.map((task, index) => {
              const isSelected = task.id === selectedId;
              const isLast = index === run.tasks.length - 1;
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
                          className={cn(
                            "h-5 w-5",
                            !isSelected && "text-slate-400"
                          )}
                        />
                      }
                      title={task.name}
                      accessory={
                        <Paragraph variant="extra-small">
                          {formatDuration(task.startedAt, task.completedAt, {
                            style: "short",
                          })}
                        </Paragraph>
                      }
                    />
                    <RunPanelBody>
                      <RunPanelIconSection>
                        {task.displayKey && (
                          <RunPanelIconElement
                            icon="key"
                            label="Key"
                            value={task.displayKey}
                          />
                        )}
                        {task.delayUntil && (
                          <RunPanelIconElement
                            icon="clock"
                            label="Total delay"
                            value={formatDurationMilliseconds(
                              task.params["seconds"] * 1000
                            )}
                          />
                        )}
                      </RunPanelIconSection>
                      <RunPanelElements
                        columns={true}
                        elements={[
                          { label: "Payment ID", value: "abcdefhjig" },
                          {
                            label: "Customer ID",
                            value: "12345",
                          },
                          { label: "ID", value: "abcdefhjig" },
                          {
                            label: "Long Customer ID",
                            value: "12345",
                          },
                        ]}
                      />
                    </RunPanelBody>
                  </RunPanel>
                  {!isLast && <TaskSeparator />}
                </Fragment>
              );
            })}

            <div>
              <Header3>Trigger</Header3>
              {JSON.stringify(run.event)}
            </div>
            <div>
              <Header2>Connections</Header2>
              <Header3>Missing</Header3>
              {JSON.stringify(run.missingConnections)}
              <Header3>Present</Header3>
              {JSON.stringify(run.runConnections)}
            </div>
            <div>
              <Header3>Tasks</Header3>
              {JSON.stringify(run.tasks)}
            </div>
          </div>
          <div>Detail</div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
