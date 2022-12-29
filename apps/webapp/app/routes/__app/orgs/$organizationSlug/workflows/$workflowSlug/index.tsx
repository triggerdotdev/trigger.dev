import { useFetcher } from "@remix-run/react";
import { useCallback, useState } from "react";
import invariant from "tiny-invariant";
import { JSONEditor } from "~/components/code/JSONEditor";
import { integrations } from "~/components/integrations/ConnectButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Select } from "~/components/primitives/Select";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { TriggerBody } from "~/components/triggers/Trigger";
import { triggerInfo } from "~/components/triggers/triggerTypes";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";

export default function Page() {
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

      {workflow.status === "READY" && (
        <Panel className="mt-4">
          <Tester
            organizationSlug={organization.slug}
            workflowSlug={workflow.slug}
            eventNames={workflow.eventNames}
          />
        </Panel>
      )}
    </>
  );
}

function Tester({
  organizationSlug,
  workflowSlug,
  eventNames,
}: {
  organizationSlug: string;
  workflowSlug: string;
  eventNames: string[];
}) {
  const testFetcher = useFetcher();
  const [testContent, setTestContent] = useState<string>("");
  const [eventName, setEventName] = useState<string>(eventNames[0]);

  const submit = useCallback(() => {
    console.log({
      payload: testContent,
    });

    testFetcher.submit(
      {
        eventName,
        payload: testContent,
      },
      {
        method: "post",
        action: `/resources/run/${organizationSlug}/test/${workflowSlug}`,
      }
    );
  }, [eventName, organizationSlug, testContent, testFetcher, workflowSlug]);

  return (
    <div className="flex flex-col gap-2">
      {eventNames.length > 1 ? (
        <Select
          name="eventName"
          defaultValue={eventName}
          onChange={(e) => setEventName(e.currentTarget.value)}
        >
          {eventNames.map((eventName) => (
            <option key={eventName} value={eventName}>
              {eventName}
            </option>
          ))}
        </Select>
      ) : null}
      <JSONEditor
        content={testContent}
        readOnly={false}
        onChange={(c) => setTestContent(c)}
      />
      <PrimaryButton onClick={submit}>Test</PrimaryButton>
    </div>
  );
}
