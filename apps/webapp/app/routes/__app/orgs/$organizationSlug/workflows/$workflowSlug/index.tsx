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
          eventRule.trigger.manualRegistration &&
          workflow.externalSourceUrl ? (
            <PanelInfo className="mb-6">
              <div className="flex flex-col">
                <Body className="mb-6">
                  Use these details to register your webhook – this usually
                  involves logging in to the developer section of the service.
                </Body>
                <div className="flex gap-8">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col gap-2">
                      <Body
                        size="extra-small"
                        className="text-slate-300 uppercase tracking-wide"
                      >
                        URL
                      </Body>
                      <div className="flex items-center gap-2">
                        <Input value={workflow.externalSourceUrl} />
                        <CopyTextButton
                          value={workflow.externalSourceUrl}
                        ></CopyTextButton>
                      </div>
                    </div>
                  </div>
                  {workflow.externalSourceSecret && (
                    <div className="flex flex-col">
                      <Body
                        size="extra-small"
                        className="text-slate-300 uppercase tracking-wide"
                      >
                        Secret
                      </Body>
                      <div className="flex items-center gap-2">
                        <Input
                          type="password"
                          value={workflow.externalSourceSecret}
                          className="mt-2"
                        />
                        <CopyTextButton
                          value={workflow.externalSourceSecret}
                        ></CopyTextButton>
                      </div>
                    </div>
                  )}
                </div>
              </div>
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
          <div className="flex justify-between items-end">
            <SubTitle>Workflow type</SubTitle>
            <SecondaryLink to="test" className="mb-2">
              Run a test
            </SecondaryLink>
          </div>
          <Panel className="mb-4">
            <PanelHeader
              icon={
                <div className="h-6 w-6 mr-1">
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
          <div className="flex justify-between items-end">
            <SubTitle>Last {pageSize} runs</SubTitle>
            <SecondaryLink to="runs" className="mb-2">
              View all
            </SecondaryLink>
          </div>
          <Panel className="p-0 overflow-hidden overflow-x-auto mb-6">
            <RunsTable
              runs={runs}
              total={total}
              hasFilters={hasFilters}
              basePath="runs"
            />
          </Panel>
        </>
      ) : (
        <>
          <SubTitle>No workflows run yet</SubTitle>
          <PrimaryLink to="test">Test your workflow</PrimaryLink>
        </>
      )}
    </>
  );
}
