import { useFetcher } from "@remix-run/react";
import { useCallback, useState } from "react";
import invariant from "tiny-invariant";
import { JSONEditor } from "~/components/code/JSONEditor";
import { Panel } from "~/components/layout/Panel";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Select } from "~/components/primitives/Select";
import { Header1 } from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";

export default function Page() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");

  return (
    <>
      <Header1 className="mb-4">Test</Header1>

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
