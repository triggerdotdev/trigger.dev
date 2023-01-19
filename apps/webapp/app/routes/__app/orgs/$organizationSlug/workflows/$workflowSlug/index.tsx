import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
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
      {workflow.status !== "READY" && (
        <>
          <PanelWarning className="mb-6">
            This workflow requires its APIs to be connected before it can run.
          </PanelWarning>
        </>
      )}
      <PanelInfo className="mb-6">
        <Body className="flex grow items-center justify-between">
          This workflow is disabled. Runs cannot be triggered or tested while
          disabled. If a run is currently in progress, it will fail.
        </Body>

        <TertiaryLink to="settings" className="mr-1">
          Settings
        </TertiaryLink>
      </PanelInfo>
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
