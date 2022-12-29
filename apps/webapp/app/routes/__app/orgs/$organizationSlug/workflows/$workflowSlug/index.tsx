import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { integrations } from "~/components/integrations/ConnectButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryLink, SecondaryLink } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { RunsTable } from "~/components/runs/Table";
import { TriggerBody } from "~/components/triggers/Trigger";
import { triggerInfo } from "~/components/triggers/triggerTypes";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
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
    const presenter = new WorkflowRunListPresenter();
    const result = await presenter.data({
      userId,
      organizationSlug,
      workflowSlug,
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
      <Header1 className="mb-4">Overview</Header1>
      {connectionSlots.length > 0 && (
        <Panel>
          <Header2 size="small" className="mb-2">
            API integrations
          </Header2>
          <div className="flex flex-col gap-4 items-stretch w-full">
            {connectionSlots.map((slot) => (
              <div key={slot.id} className="flex flex-col gap-1">
                <Body>{slot.integration?.name}</Body>
                <ConnectionSelector
                  sourceId={slot.id}
                  organizationId={organization.id}
                  integration={integrations[0]}
                  connections={slot.possibleConnections}
                  selectedConnectionId={slot.connection?.id}
                />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {eventRule && (
        <Panel className="mt-4">
          <PanelHeader
            icon={triggerInfo[eventRule.trigger.type].icon}
            title={triggerInfo[eventRule.trigger.type].label}
            startedAt={null}
            finishedAt={null}
          />
          <TriggerBody trigger={eventRule.trigger} />
        </Panel>
      )}

      {total > 0 ? (
        <>
          <div className="mt-6 mb-4 flex justify-between items-center">
            <Header2>Last {pageSize} runs</Header2>
            <SecondaryLink to="runs">View all</SecondaryLink>
          </div>
          <Panel className="p-0 overflow-hidden overflow-x-auto">
            <RunsTable runs={runs} total={total} hasFilters={hasFilters} />
          </Panel>
        </>
      ) : (
        <>
          <Header2 className="mt-6 mb-4">No workflows runs</Header2>
          <PrimaryLink to="test">Test your workflow</PrimaryLink>
        </>
      )}
    </>
  );
}
