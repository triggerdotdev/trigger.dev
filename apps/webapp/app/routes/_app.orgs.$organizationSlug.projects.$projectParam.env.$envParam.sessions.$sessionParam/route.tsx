import { ArrowsRightLeftIcon, BookOpenIcon, XCircleIcon } from "@heroicons/react/24/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { CodeBlock } from "~/components/code/CodeBlock";
import { PageBody } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { AgentView } from "~/components/runs/v3/agent/AgentView";
import { RealtimeStreamViewer } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.streams.$streamKey/route";
import { RunTag } from "~/components/runs/v3/RunTag";
import {
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { CloseSessionDialog } from "~/components/sessions/v1/CloseSessionDialog";
import { SessionStatusCombo } from "~/components/sessions/v1/SessionStatus";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useHasAdminAccess } from "~/hooks/useUser";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { SessionPresenter } from "~/presenters/v3/SessionPresenter.server";
import { type SessionStatus } from "~/services/sessionsRepository/sessionsRepository.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  EnvironmentParamSchema,
  v3RunPath,
  v3RunsPath,
  v3SessionsPath,
} from "~/utils/pathBuilder";

const ParamsSchema = EnvironmentParamSchema.extend({
  sessionParam: z.string(),
});

export const meta: MetaFunction = () => {
  return [{ title: `Session | Trigger.dev` }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, sessionParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const presenter = new SessionPresenter($replica);
  const session = await presenter.call({
    userId,
    environmentId: environment.id,
    sessionParam,
    projectExternalRef: project.externalRef,
    environmentSlug: environment.slug,
  });

  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }

  return typedjson({ session });
};

export default function Page() {
  const { session } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const status: SessionStatus =
    session.closedAt != null
      ? "CLOSED"
      : session.expiresAt != null && new Date(session.expiresAt).getTime() < Date.now()
        ? "EXPIRED"
        : "ACTIVE";

  const displayId = session.externalId ?? session.friendlyId;
  const sessionsPath = v3SessionsPath(organization, project, environment);

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: sessionsPath, text: "Sessions" }}
          title={
            <CopyableText
              value={displayId}
              variant="text-below"
              className="-ml-[0.4375rem] h-6 px-1.5 font-mono text-xs hover:text-text-bright"
            />
          }
        />
        <PageAccessories>
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/ai-chat/overview")}
          >
            Sessions docs
          </LinkButton>
          {status === "ACTIVE" && (
            <Dialog key={`close-${session.friendlyId}`}>
              <DialogTrigger asChild>
                <Button variant="danger/small" LeadingIcon={XCircleIcon}>
                  Close session…
                </Button>
              </DialogTrigger>
              <CloseSessionDialog
                sessionParam={session.friendlyId}
                environmentId={environment.id}
                redirectPath={`${sessionsPath}/${session.friendlyId}`}
              />
            </Dialog>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="session-conversation" min={"300px"}>
            <ConversationPane session={session} />
          </ResizablePanel>
          <ResizableHandle id="session-handle" />
          <ResizablePanel
            id="session-inspector"
            min="380px"
            default="420px"
            className="overflow-hidden"
          >
            <InspectorPane session={session} status={status} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

type LoadedSession = ReturnType<typeof useTypedLoaderData<typeof loader>>["session"];

function ConversationPane({ session }: { session: LoadedSession }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { value, replace } = useSearchParams();
  const isRaw = value("raw") === "1";
  const stream: "out" | "in" = value("stream") === "in" ? "in" : "out";

  const sessionId = session.agentView.sessionId;
  const encodedSession = encodeURIComponent(sessionId);
  const sessionResourceBase = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/sessions/${encodedSession}/realtime/v1`;

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-bright px-3">
        <div className="flex items-center gap-2 overflow-x-hidden">
          <ArrowsRightLeftIcon className="size-4 text-teal-500" />
          <Header2 className={cn("overflow-x-hidden text-text-bright")}>
            <span className="truncate">Conversation</span>
          </Header2>
        </div>
        <SegmentedControl
          name="conversation-view"
          value={isRaw ? "raw" : "rendered"}
          variant="secondary/small"
          options={[
            { label: "Rendered", value: "rendered" },
            { label: "Raw", value: "raw" },
          ]}
          onChange={(v) => replace({ raw: v === "raw" ? "1" : undefined })}
        />
      </div>
      {isRaw ? (
        <div className="overflow-hidden">
          <RealtimeStreamViewer
            key={stream}
            resourcePath={`${sessionResourceBase}/${stream}`}
            displayName={`.${stream}`}
            headerLeft={
              <TabContainer>
                <TabButton
                  isActive={stream === "out"}
                  layoutId="conversation-stream"
                  onClick={() => replace({ stream: undefined })}
                >
                  Output
                </TabButton>
                <TabButton
                  isActive={stream === "in"}
                  layoutId="conversation-stream"
                  onClick={() => replace({ stream: "in" })}
                >
                  Input
                </TabButton>
              </TabContainer>
            }
          />
        </div>
      ) : (
        <div className="min-w-0 overflow-x-hidden overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <AgentView agentView={session.agentView} />
        </div>
      )}
    </div>
  );
}

function InspectorPane({
  session,
  status,
}: {
  session: LoadedSession;
  status: SessionStatus;
}) {
  const { value, replace } = useSearchParams();
  const tab = value("tab") ?? "overview";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const displayId = session.externalId ?? session.friendlyId;
  const allRunsPath = v3RunsPath(organization, project, environment, {
    tags: [`chat:${displayId}`],
  });

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3">
        <div className="flex items-center gap-2 overflow-x-hidden">
          <SessionStatusCombo status={status} />
          <span className="truncate font-mono text-xs text-text-dimmed">
            {session.friendlyId}
          </span>
        </div>
      </div>
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <TabContainer>
          <TabButton
            isActive={tab === "overview"}
            layoutId="session-inspector"
            onClick={() => replace({ tab: "overview" })}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "runs"}
            layoutId="session-inspector"
            onClick={() => replace({ tab: "runs" })}
            shortcut={{ key: "r" }}
          >
            Runs
          </TabButton>
          <TabButton
            isActive={tab === "metadata"}
            layoutId="session-inspector"
            onClick={() => replace({ tab: "metadata" })}
            shortcut={{ key: "m" }}
          >
            Metadata
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" ? (
          <OverviewTab session={session} status={status} />
        ) : tab === "runs" ? (
          <RunsTab session={session} allRunsPath={allRunsPath} />
        ) : (
          <MetadataTab session={session} />
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  session,
  status,
}: {
  session: LoadedSession;
  status: SessionStatus;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isAdmin = useHasAdminAccess();

  return (
    <div className="flex flex-col gap-4">
      <Property.Table>
        <Property.Item>
          <Property.Label>Status</Property.Label>
          <Property.Value>
            <SessionStatusCombo status={status} />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Friendly ID</Property.Label>
          <Property.Value>
            <CopyableText value={session.friendlyId} className="font-mono text-xs" />
          </Property.Value>
        </Property.Item>
        {session.externalId ? (
          <Property.Item>
            <Property.Label>External ID</Property.Label>
            <Property.Value>
              <CopyableText value={session.externalId} className="font-mono text-xs" />
            </Property.Value>
          </Property.Item>
        ) : null}
        <Property.Item>
          <Property.Label>Type</Property.Label>
          <Property.Value>
            <span className="font-mono text-xs">{session.type}</span>
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Task</Property.Label>
          <Property.Value>
            <span className="font-mono text-xs">{session.taskIdentifier}</span>
          </Property.Value>
        </Property.Item>
        {session.currentRun ? (
          <Property.Item>
            <Property.Label>Current run</Property.Label>
            <Property.Value>
              <TextLink
                to={v3RunPath(organization, project, environment, {
                  friendlyId: session.currentRun.friendlyId,
                })}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs">{session.currentRun.friendlyId}</span>
                  <SimpleTooltip
                    button={<TaskRunStatusCombo status={session.currentRun.status} />}
                    content={descriptionForTaskRunStatus(session.currentRun.status)}
                    disableHoverableContent
                  />
                </span>
              </TextLink>
            </Property.Value>
          </Property.Item>
        ) : null}
        <Property.Item>
          <Property.Label>Tags</Property.Label>
          <Property.Value>
            {session.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {session.tags.map((tag) => (
                  <RunTag key={tag} tag={tag} />
                ))}
              </div>
            ) : (
              <span className="text-text-dimmed">–</span>
            )}
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Created</Property.Label>
          <Property.Value>
            <DateTime date={session.createdAt} />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Updated</Property.Label>
          <Property.Value>
            <DateTime date={session.updatedAt} />
          </Property.Value>
        </Property.Item>
        {session.expiresAt ? (
          <Property.Item>
            <Property.Label>
              {new Date(session.expiresAt).getTime() < Date.now() ? "Expired" : "Expires"}
            </Property.Label>
            <Property.Value>
              <DateTime date={session.expiresAt} />
            </Property.Value>
          </Property.Item>
        ) : null}
        {session.closedAt ? (
          <Property.Item>
            <Property.Label>Closed</Property.Label>
            <Property.Value>
              <DateTime date={session.closedAt} />
            </Property.Value>
          </Property.Item>
        ) : null}
        {session.closedReason ? (
          <Property.Item>
            <Property.Label>Close reason</Property.Label>
            <Property.Value>
              <span className="text-xs">{session.closedReason}</span>
            </Property.Value>
          </Property.Item>
        ) : null}
      </Property.Table>
      <CodeBlock
        code={JSON.stringify(session.triggerConfig, null, 2)}
        language="json"
        rowTitle="Trigger config"
        maxLines={20}
        showLineNumbers={false}
        showTextWrapping
      />
      {isAdmin && (
        <div className="border-t border-yellow-500/50 pt-2">
          <Paragraph spacing variant="small" className="text-yellow-500">
            Admin only
          </Paragraph>
          <Property.Table>
            <Property.Item>
              <Property.Label>Session ID</Property.Label>
              <Property.Value>
                <span className="font-mono text-xs">{session.id}</span>
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Stream basin</Property.Label>
              <Property.Value>
                <span className="font-mono text-xs">
                  {session.streamBasinName ?? "(global)"}
                </span>
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </div>
      )}
    </div>
  );
}

function MetadataTab({ session }: { session: LoadedSession }) {
  if (session.metadata == null) {
    return (
      <Paragraph variant="small/dimmed">No metadata.</Paragraph>
    );
  }
  const json = JSON.stringify(session.metadata, null, 2);
  return (
    <CodeBlock code={json} language="json" showLineNumbers={false} showTextWrapping />
  );
}

function RunsTab({
  session,
  allRunsPath,
}: {
  session: LoadedSession;
  allRunsPath: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (session.runs.length === 0) {
    return <Paragraph variant="small/dimmed">No runs yet.</Paragraph>;
  }

  return (
    <div className="flex flex-col gap-3">
      <Property.Table>
        {session.runs.map((entry) => {
          const runPath = entry.run
            ? v3RunPath(organization, project, environment, {
                friendlyId: entry.run.friendlyId,
              })
            : undefined;
          return (
            <Property.Item key={entry.id}>
              <Property.Label>
                <div className="flex flex-col gap-0.5">
                  <span className="capitalize">{entry.reason}</span>
                  <span className="text-xs text-text-dimmed">
                    <DateTime date={entry.triggeredAt} />
                  </span>
                </div>
              </Property.Label>
              <Property.Value>
                {entry.run && runPath ? (
                  <SimpleTooltip
                    button={
                      <TextLink
                        to={runPath}
                        className="group flex flex-wrap items-center gap-x-2 gap-y-0"
                      >
                        <CopyableText
                          value={entry.run.friendlyId}
                          copyValue={entry.run.friendlyId}
                          asChild
                        />
                        <TaskRunStatusCombo status={entry.run.status} />
                      </TextLink>
                    }
                    content={`Jump to run`}
                    disableHoverableContent
                  />
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </Property.Value>
            </Property.Item>
          );
        })}
      </Property.Table>
      <div className="flex justify-end">
        <LinkButton variant="tertiary/small" to={allRunsPath}>
          View all runs
        </LinkButton>
      </div>
    </div>
  );
}

