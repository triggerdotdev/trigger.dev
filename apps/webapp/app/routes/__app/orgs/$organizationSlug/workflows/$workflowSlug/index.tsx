import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryLink, SecondaryLink } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { RunsTable } from "~/components/runs/RunsTable";
import { TriggerBody } from "~/components/triggers/Trigger";
import { triggerInfo } from "~/components/triggers/triggerTypes";
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

  return (
    <>
      <Title>Overview</Title>
      {(connectionSlots.source || connectionSlots.services.length > 0) && (
        <>
          <SubTitle>
            {connectionSlots.services.length} connected API
            {connectionSlots.services.length === 1 ? "" : "s"}
          </SubTitle>
          <Panel className="mb-6">
            <WorkflowConnections />
          </Panel>
        </>
      )}

      {eventRule && (
        <>
          <SubTitle>Workflow type</SubTitle>
          <Panel className="mb-4">
            <PanelHeader
              icon={triggerInfo[eventRule.trigger.type].icon}
              title={triggerInfo[eventRule.trigger.type].label}
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
          <Panel className="p-0 overflow-hidden overflow-x-auto">
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
