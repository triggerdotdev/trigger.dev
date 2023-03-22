import { useFetcher } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { useCallback, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentBanner } from "~/components/EnvironmentBanner";
import { Panel } from "~/components/layout/Panel";
import { PanelInfo } from "~/components/layout/PanelInfo";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { PrimaryButton, TertiaryLink } from "~/components/primitives/Buttons";
import { Select } from "~/components/primitives/Select";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { CurrentWorkflow, useCurrentWorkflow } from "~/hooks/useWorkflows";
import { WorkflowTestPresenter } from "~/presenters/testPresenter.server";
import { requireUserId } from "~/services/session.server";
import { useCurrentEventRule } from "../$workflowSlug";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { workflowSlug, organizationSlug } = params;
  invariant(workflowSlug, "workflowSlug is required");
  invariant(organizationSlug, "organizationSlug is required");

  try {
    const presenter = new WorkflowTestPresenter();

    return typedjson(
      await presenter.data({ workflowSlug, organizationSlug, userId })
    );
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const { payload, status } = useTypedLoaderData<typeof loader>();

  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");

  const eventRule = useCurrentEventRule();

  return (
    <>
      <Title>Test</Title>
      {status === "CREATED" && (
        <PanelWarning
          message="This workflow requires its APIs to be connected before it can run."
          className="mb-6"
        />
      )}
      {status === "DISABLED" ? (
        <PanelInfo
          message="This workflow is disabled. Runs cannot be triggered or tested while
        disabled. Runs in progress will continue until complete."
          className="mb-6"
        >
          <TertiaryLink to="settings" className="mr-1">
            Settings
          </TertiaryLink>
        </PanelInfo>
      ) : (
        <>
          {eventRule ? (
            <>
              <SubTitle>{workflowType(workflow)}</SubTitle>
              <Panel>
                <Tester
                  organizationSlug={organization.slug}
                  workflowSlug={workflow.slug}
                  eventNames={workflow.eventNames}
                  initialValue={JSON.stringify(payload, null, 2)}
                />
              </Panel>
            </>
          ) : (
            <Panel className="px-4 py-4">
              Connect this workflow to the Live environment using your Live API
              Key to enable testing.
            </Panel>
          )}
        </>
      )}
    </>
  );
}

function Tester({
  organizationSlug,
  workflowSlug,
  eventNames,
  initialValue,
}: {
  organizationSlug: string;
  workflowSlug: string;
  eventNames: string[];
  initialValue: string;
}) {
  const testFetcher = useFetcher();
  const [testContent, setTestContent] = useState<string>(initialValue);
  const [eventName, setEventName] = useState<string>(eventNames[0]);

  const submit = useCallback(() => {
    console.log({
      payload: testContent,
    });

    testFetcher.submit(
      {
        eventName,
        payload: testContent,
        source: "test",
      },
      {
        method: "post",
        action: `/resources/run/${organizationSlug}/test/${workflowSlug}`,
      }
    );
  }, [eventName, organizationSlug, testContent, testFetcher, workflowSlug]);

  return (
    <>
      <EnvironmentBanner />
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
          maxHeight="calc(100vh - 300px)"
        />
        <PrimaryButton onClick={submit}>Run test</PrimaryButton>
      </div>
    </>
  );
}

function workflowType(workflow: CurrentWorkflow) {
  switch (workflow?.type) {
    case "WEBHOOK":
      return "This test will simulate receiving this JSON payload for this webhook.";
    case "SCHEDULE":
      return "This test will simulate receiving a scheduled trigger from this datetime string.";
    case "CUSTOM_EVENT":
      return "This test will simulate receiving this JSON payload for this custom event.";
    default:
      return "This workflow hasn't been connected.";
  }
}
