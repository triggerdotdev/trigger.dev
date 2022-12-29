import { Form, useFetcher } from "@remix-run/react";
import { useCallback, useState } from "react";
import invariant from "tiny-invariant";
import { JSONEditor } from "~/components/code/JSONEditor";
import { integrations } from "~/components/integrations/ConnectButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { TriggerBody } from "~/components/triggers/Trigger";
import { triggerInfo } from "~/components/triggers/triggerTypes";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";

export default function Page() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");
  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment not found");

  const testFetcher = useFetcher();

  const eventRule = workflow.rules.find(
    (r) => r.environmentId === environment.id
  );

  const [testContent, setTestContent] = useState<string>("");

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

      {workflow.status === "READY" && (
        <Panel className="mt-4">
          <Tester
            organizationSlug={organization.slug}
            workflowSlug={workflow.slug}
            environment={environment}
          />
        </Panel>
      )}
    </>
  );
}

function Tester({
  organizationSlug,
  workflowSlug,
  environment,
}: {
  organizationSlug: string;
  workflowSlug: string;
  environment: RuntimeEnvironment;
}) {
  const testFetcher = useFetcher();
  const [testContent, setTestContent] = useState<string>("");

  const submit = useCallback(() => {
    console.log({
      environmentId: environment.id,
      apiKey: environment.apiKey,
      data: testContent,
    });

    testFetcher.submit(
      {
        environmentId: environment.id,
        apiKey: environment.apiKey,
        payload: testContent,
      },
      {
        method: "post",
        action: `/resources/run/${organizationSlug}/test/${workflowSlug}`,
      }
    );
  }, [
    environment.apiKey,
    environment.id,
    organizationSlug,
    testContent,
    testFetcher,
    workflowSlug,
  ]);

  return (
    <div className="flex flex-col gap-2">
      <JSONEditor
        content={testContent}
        readOnly={false}
        onChange={(c) => setTestContent(c)}
      />
      <PrimaryButton onClick={submit}>Test</PrimaryButton>
    </div>
  );
}
