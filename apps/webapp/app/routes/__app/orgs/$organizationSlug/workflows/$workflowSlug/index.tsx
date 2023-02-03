import { EventRule } from ".prisma/client";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import CodeBlock from "~/components/code/CodeBlock";
import { CopyTextButton } from "~/components/CopyTextButton";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PanelInfo } from "~/components/layout/PanelInfo";
import { PanelWarning } from "~/components/layout/PanelWarning";
import {
  PrimaryLink,
  SecondaryLink,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { RunsTable } from "~/components/runs/RunsTable";
import { TriggerBody } from "~/components/triggers/Trigger";
import { TriggerTypeIcon } from "~/components/triggers/TriggerIcons";
import { triggerLabel } from "~/components/triggers/triggerLabel";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import { WorkflowRunListPresenter } from "~/models/workflowRunListPresenter.server";
import { requireUserId } from "~/services/session.server";

const pageSize = 10;

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");
  invariant(workflowSlug, "workflowSlug is required");

  const searchParams = new URLSearchParams();

  try {
    const environmentSlug = await getRuntimeEnvironmentFromRequest(request);
    const presenter = new WorkflowRunListPresenter();
    const result = await presenter.data({
      userId,
      organizationSlug,
      workflowSlug,
      environmentSlug,
      searchParams,
      pageSize,
    });
    return typedjson(result);
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const { runs, total, hasFilters } = useTypedLoaderData<typeof loader>();

  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");
  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment not found");

  const eventRule = workflow.rules.find(
    (r) => r.environmentId === environment.id
  );

  const apiConnectionCount =
    connectionSlots.services.length + (connectionSlots.source ? 1 : 0);

  return (
    <>
      <div className="flex items-baseline justify-between">
        <Title>Overview</Title>
        <Body className="text-slate-400">
          <span className="mr-1.5 text-xs tracking-wide text-slate-500">
            ID
          </span>
          {workflow.slug}
        </Body>
      </div>
      {workflow.status === "CREATED" && (
        <>
          {eventRule &&
          eventRule.trigger.type === "WEBHOOK" &&
          workflow.externalSourceConfig?.type === "manual" ? (
            <PanelInfo className="mb-6 pb-4">
              {workflow.externalSourceConfig.data.success ? (
                <div className="flex flex-col">
                  <Body className="mb-4">
                    Use these details to register your webhook – this usually
                    involves logging in to the developer section of the service.
                  </Body>
                  <div className="flex flex-col gap-2">
                    <Body
                      size="extra-small"
                      className="uppercase tracking-wide text-slate-300"
                    >
                      URL
                    </Body>
                    <div className="mb-4 flex items-center gap-2">
                      <Input
                        value={workflow.externalSourceConfig.data.url}
                        readOnly={true}
                      />
                      <CopyTextButton
                        value={workflow.externalSourceConfig.data.url}
                      ></CopyTextButton>
                    </div>
                  </div>
                  {workflow.externalSourceConfig.data.secret && (
                    <div className="flex flex-col gap-2">
                      <Body
                        size="extra-small"
                        className="uppercase tracking-wide text-slate-300"
                      >
                        Secret
                      </Body>
                      <div className="flex items-center gap-2">
                        <Input
                          type="password"
                          value={workflow.externalSourceConfig.data.secret}
                          readOnly={true}
                        />
                        <CopyTextButton
                          value={workflow.externalSourceConfig.data.secret}
                        ></CopyTextButton>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex w-full flex-col gap-2">
                  <Body className="text-rose-500">
                    Your custom webhook event is incorrectly formatted. See the
                    error below
                  </Body>
                  <CodeBlock
                    code={workflow.externalSourceConfig.data.error}
                    className="w-full border border-rose-500"
                    align="top"
                  />
                </div>
              )}
            </PanelInfo>
          ) : (
            <PanelWarning className="mb-6">
              This workflow requires its APIs to be connected before it can run.
            </PanelWarning>
          )}
        </>
      )}
      {workflow.status === "DISABLED" && (
        <PanelInfo className="mb-6">
          <Body className="flex grow items-center justify-between">
            This workflow is disabled. Runs cannot be triggered or tested while
            disabled. Runs in progress will continue until complete.
          </Body>

          <TertiaryLink to="settings" className="mr-1">
            Settings
          </TertiaryLink>
        </PanelInfo>
      )}
      {apiConnectionCount > 0 && <WorkflowConnections />}
      {eventRule && (
        <>
          <div className="flex items-end justify-between">
            <SubTitle>Workflow type</SubTitle>
            <SecondaryLink to="test" className="mb-2">
              Run a test
            </SecondaryLink>
          </div>
          <Panel className="mb-4">
            <PanelHeader
              icon={
                <div className="mr-1 h-6 w-6">
                  <TriggerTypeIcon
                    type={eventRule.trigger.type}
                    provider={connectionSlots.source?.integration}
                  />
                </div>
              }
              title={triggerLabel(eventRule.trigger.type)}
              startedAt={null}
              finishedAt={null}
            />
            <TriggerBody trigger={eventRule.trigger} />
          </Panel>
        </>
      )}

      {total > 0 ? (
        <>
          <div className="flex items-end justify-between">
            <SubTitle>Last {pageSize} runs</SubTitle>
            <SecondaryLink to="runs" className="mb-2">
              View all
            </SecondaryLink>
          </div>
          <Panel className="mb-6 overflow-hidden overflow-x-auto p-0">
            <RunsTable
              runs={runs}
              total={total}
              hasFilters={hasFilters}
              basePath="runs"
            />
          </Panel>
        </>
      ) : (
        <Panel>
          <div className="flex items-start gap-2 p-1">
            <ExclamationTriangleIcon className="mt-1 h-5 w-5 text-amber-400" />
            <div>
              <Header3>This workflow hasn't been run yet</Header3>
              <Body className="mt-1 mb-2 text-slate-300">
                If you want to quickly test the workflow, you can use the test
                feature.
              </Body>
              <PrimaryLink to="test">Test your workflow</PrimaryLink>
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}
