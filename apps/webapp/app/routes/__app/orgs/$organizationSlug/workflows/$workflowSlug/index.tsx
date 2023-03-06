import { EventRule } from ".prisma/client";
import { Disclosure } from "@headlessui/react";
import { BeakerIcon, CheckCircleIcon } from "@heroicons/react/20/solid";
import {
  ArrowsRightLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { DisplayPropertiesSchema } from "@trigger.dev/integration-sdk";
import classNames from "classnames";
import {
  typedjson,
  UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import CodeBlock from "~/components/code/CodeBlock";
import { CopyTextButton } from "~/components/CopyTextButton";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
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
import { PlugIcon } from "~/components/primitives/IconPlug";
import { Input } from "~/components/primitives/Input";
import { Body } from "~/components/primitives/text/Body";
import { Header2 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { RunsTable } from "~/components/runs/RunsTable";
import { TriggerBody } from "~/components/triggers/Trigger";
import { TriggerTypeIcon } from "~/components/triggers/TriggerIcons";
import { triggerLabel } from "~/components/triggers/triggerLabel";
import { DEV_ENVIRONMENT } from "~/consts";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import { WorkflowRunListPresenter } from "~/presenters/workflowRunListPresenter.server";
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
  const { runs, total, totalRealRuns, hasFilters } =
    useTypedLoaderData<typeof loader>();

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

  //if the workflow isn't connected in this environment, show a warning and help message
  if (!eventRule) {
    return (
      <>
        <Title>Overview</Title>
        <PanelWarning
          className="mb-6"
          message={`This workflow hasn't been connected in the ${environment.slug} environment yet.`}
        ></PanelWarning>
        {environment.slug === DEV_ENVIRONMENT ? (
          <ConnectToDevelopmentInstructions environment={environment} />
        ) : (
          <ConnectToLiveInstructions environment={environment} />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex items-baseline justify-between">
        <Title>Overview</Title>
        <div className="flex items-center gap-4">
          {workflow.organizationTemplate && (
            <a
              href={workflow.organizationTemplate.repositoryUrl}
              className="flex items-center gap-1 text-sm text-slate-400 transition hover:text-slate-200"
              target="_blank"
              rel="noreferrer"
            >
              <OctoKitty className="mr-0.5 h-4 w-4" />
              {workflow.organizationTemplate.repositoryUrl.replace(
                "https://github.com/",
                ""
              )}
            </a>
          )}
          <Body size="small" className="text-slate-400">
            <span className="mr-1.5 text-xs tracking-wide text-slate-500">
              ID
            </span>
            {workflow.slug}
          </Body>
        </div>
      </div>

      {workflow.status === "DISABLED" && (
        <PanelInfo
          message="This workflow is disabled. Runs cannot be triggered or tested while
        disabled. Runs in progress will continue until complete."
          className="mb-6"
        >
          <TertiaryLink to="settings" className="mr-1">
            Settings
          </TertiaryLink>
        </PanelInfo>
      )}

      {eventRule && (
        <>
          <div className="flex items-end justify-between">
            <SubTitle>Your workflow</SubTitle>
            <SecondaryLink to="test" className="mb-2">
              Test workflow
            </SecondaryLink>
          </div>
          <Panel className="rounded-b-none">
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
            <TriggerBody
              trigger={eventRule.trigger}
              displayProperties={workflow.triggerDisplayProperties}
            />
          </Panel>
          <div className="divide-y divide-slate-800 rounded-b-md">
            {connectionSlots.source &&
            connectionSlots.source.connection === null ? (
              <Disclosure defaultOpen={true}>
                {({ open }) => (
                  <div className="border border-red-500 bg-rose-500/20">
                    <Disclosure.Button className="flex w-full items-center justify-between bg-slate-800/70 py-4 px-4 transition hover:bg-slate-800/50">
                      <div className="flex items-center gap-2">
                        <Cog6ToothIcon className="h-6 w-6 text-rose-500" />
                        <Body>
                          Connect to{" "}
                          {connectionSlots.source &&
                            connectionSlots.source.integration.name}{" "}
                          so your workflow can be triggered
                        </Body>
                      </div>
                      <div className="flex items-center gap-2">
                        <Body size="small" className="text-slate-400">
                          {open ? "Close" : "Open"}
                        </Body>
                        <ChevronDownIcon
                          className={classNames(
                            open ? "rotate-180 transform" : "",
                            "h-5 w-5 text-slate-400 transition"
                          )}
                        />
                      </div>
                    </Disclosure.Button>
                    <Disclosure.Panel className="p-4">
                      {connectionSlots.source && (
                        <div
                          className={classNames(
                            "flex w-full items-center gap-4 rounded-md !border !border-slate-900 bg-slate-800 px-4 py-4"
                          )}
                        >
                          <ApiLogoIcon
                            integration={connectionSlots.source.integration}
                            size="regular"
                          />
                          <div className="flex w-full items-center justify-between gap-1">
                            <Body>
                              {connectionSlots.source.integration.name}
                            </Body>
                            <ConnectionSelector
                              type="source"
                              sourceServiceId={connectionSlots.source.id}
                              organizationId={organization.id}
                              integration={connectionSlots.source.integration}
                              connections={
                                connectionSlots.source.possibleConnections
                              }
                              className="mr-1"
                              popoverAlign="right"
                            />
                          </div>
                        </div>
                      )}
                    </Disclosure.Panel>
                  </div>
                )}
              </Disclosure>
            ) : (
              <></>
            )}
            {eventRule &&
              eventRule.trigger.type === "WEBHOOK" &&
              workflow.externalSourceConfig?.type === "manual" && (
                <Disclosure defaultOpen={true}>
                  {({ open }) => (
                    <div className="bg-slate-700/80">
                      <Disclosure.Button className="flex w-full items-center justify-between bg-slate-800/70 py-4 px-4 transition hover:bg-slate-800/50">
                        <div className="flex items-center gap-2">
                          <Cog6ToothIcon className="h-6 w-6 text-green-500" />
                          {workflow.status === "CREATED" ? (
                            <Body>Register your webhook</Body>
                          ) : (
                            <Body>Webhook details</Body>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Body size="small" className="text-slate-400">
                            {open ? "Close" : "Open"}
                          </Body>
                          <ChevronDownIcon
                            className={classNames(
                              open ? "rotate-180 transform" : "",
                              "h-5 w-5 text-slate-400 transition"
                            )}
                          />
                        </div>
                      </Disclosure.Button>
                      <Disclosure.Panel className="p-6">
                        <>
                          {eventRule &&
                          eventRule.trigger.type === "WEBHOOK" &&
                          workflow.externalSourceConfig?.type === "manual" ? (
                            <div className="">
                              {workflow.externalSourceConfig.data.success ? (
                                <>
                                  {workflow.status === "CREATED" ? (
                                    <SubTitle className="mb-4 text-slate-200">
                                      Use these details to register your
                                      webhook. This usually involves logging in
                                      to the developer section of the service.
                                    </SubTitle>
                                  ) : (
                                    <div className="mb-4 flex items-center gap-1">
                                      <CheckCircleIcon className="h-5 w-5 text-slate-400" />
                                      <SubTitle className="mb-0 text-slate-200">
                                        Your webhook has been registered.
                                      </SubTitle>
                                    </div>
                                  )}

                                  <div className="grid grid-cols-2 gap-4">
                                    <div className="flex flex-col gap-2">
                                      <Body
                                        size="extra-small"
                                        className="uppercase tracking-wide text-slate-500"
                                      >
                                        URL
                                      </Body>
                                      <div className="flex items-center gap-2">
                                        <Input
                                          value={
                                            workflow.externalSourceConfig.data
                                              .url
                                          }
                                          readOnly={true}
                                          className="truncate"
                                        />
                                        <CopyTextButton
                                          value={
                                            workflow.externalSourceConfig.data
                                              .url
                                          }
                                        ></CopyTextButton>
                                      </div>
                                    </div>
                                    {workflow.externalSourceConfig.data
                                      .secret && (
                                      <div className="flex flex-col gap-2">
                                        <Body
                                          size="extra-small"
                                          className="uppercase tracking-wide text-slate-500"
                                        >
                                          Secret
                                        </Body>
                                        <div className="flex items-center gap-2">
                                          <Input
                                            type="password"
                                            value={
                                              workflow.externalSourceConfig.data
                                                .secret
                                            }
                                            readOnly={true}
                                          />
                                          <CopyTextButton
                                            value={
                                              workflow.externalSourceConfig.data
                                                .secret
                                            }
                                          ></CopyTextButton>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <div className="flex w-full flex-col gap-2">
                                  <Body className="text-rose-500">
                                    Your custom webhook event is incorrectly
                                    formatted. See the error below
                                  </Body>
                                  <CodeBlock
                                    code={
                                      workflow.externalSourceConfig.data.error
                                    }
                                    className="w-full border border-rose-500"
                                    align="top"
                                  />
                                </div>
                              )}
                            </div>
                          ) : (
                            <PanelWarning
                              className="mb-6"
                              message="This workflow requires its APIs to be connected before it can run."
                            />
                          )}
                        </>
                      </Disclosure.Panel>
                    </div>
                  )}
                </Disclosure>
              )}
            <Disclosure defaultOpen={totalRealRuns === 0}>
              {({ open }) => (
                <div className="rounded-b-md bg-slate-700/80">
                  <Disclosure.Button className="flex w-full items-center justify-between bg-slate-800/70 py-4 px-4 transition hover:bg-slate-800/50">
                    <div className="flex items-center gap-2">
                      <ArrowsRightLeftIcon className="h-6 w-6 text-green-500" />
                      <Body>How to run your workflow</Body>
                    </div>
                    <div className="flex items-center gap-2">
                      <Body size="small" className="text-slate-400">
                        {open ? "Close" : "Open"}
                      </Body>
                      <ChevronDownIcon
                        className={classNames(
                          open ? "rotate-180 transform" : "",
                          "h-5 w-5 text-slate-400 transition"
                        )}
                      />
                    </div>
                  </Disclosure.Button>
                  <Disclosure.Panel className="p-6">
                    <div className="mb-1 flex items-baseline gap-2">
                      <SubTitle className="text-slate-300">
                        Trigger your workflow for real
                      </SubTitle>
                      <span className="relative -top-0.5 rounded-full bg-blue-700 px-2 pt-1 pb-0.5 text-[0.6rem] font-medium uppercase tracking-wider text-blue-200">
                        Recommended
                      </span>
                    </div>
                    <ol className="flex list-inside list-decimal flex-col gap-1.5 border-b border-slate-800 pb-4 pl-2 text-slate-400">
                      <li>{howToText(eventRule)}</li>
                      <li>Return here to view the new workflow run.</li>
                    </ol>
                    <SubTitle className="mt-4 mb-3 text-slate-300">
                      Trigger your workflow from a test
                    </SubTitle>
                    <SecondaryLink
                      to="test"
                      className="!bg-slate-800/50 ring-slate-800 hover:!bg-slate-800/30"
                    >
                      <BeakerIcon className="-ml-1 h-4 w-4 text-slate-300" />
                      Test your workflow
                    </SecondaryLink>
                  </Disclosure.Panel>
                </div>
              )}
            </Disclosure>
          </div>
        </>
      )}
      {apiConnectionCount > 0 && (
        <WorkflowConnections
          connectionSlots={
            connectionSlots.source?.connection
              ? [
                  { ...connectionSlots.source, type: "source" as const },
                  ...connectionSlots.services.map((service) => ({
                    ...service,
                    type: "service" as const,
                  })),
                ]
              : connectionSlots.services.map((service) => ({
                  ...service,
                  type: "service" as const,
                }))
          }
          className="mt-6"
        />
      )}

      {total > 0 && (
        <>
          <div className="mt-6 flex items-end justify-between">
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
      )}
    </>
  );
}

function ConnectToLiveInstructions({
  environment,
}: {
  environment: RuntimeEnvironment;
}) {
  return (
    <>
      <Header2>Deploying your workflow to Live</Header2>
      <div className="mt-4 flex flex-col gap-2">
        <Body>
          Deploying your code to a server is different for each hosting
          provider. We have a quick start guide for{" "}
          <a
            href="https://docs.trigger.dev/quickstarts/render"
            className="underline"
          >
            how to do this with Render
          </a>
          , but you can use any hosting provider.
        </Body>

        <Body>
          When you fill in the environment variables for your server(s) use the
          following settings:
        </Body>
        <div className="flex w-full items-stretch justify-items-stretch gap-2">
          <div className="flex-grow">
            <Body className="font-bold">Key</Body>
            <CodeBlock
              code="TRIGGER_API_KEY"
              showLineNumbers={false}
              align="top"
            />
          </div>
          <div className="flex-grow">
            <Body className="font-bold">Value</Body>
            <CodeBlock
              code={environment.apiKey}
              showLineNumbers={false}
              align="top"
            />
          </div>
        </div>
      </div>
    </>
  );
}

function ConnectToDevelopmentInstructions({
  environment,
}: {
  environment: RuntimeEnvironment;
}) {
  return (
    <>
      <Header2>Running your workflow locally</Header2>
      <div className="mt-4 flex flex-col gap-2">
        <Body>
          Follow our{" "}
          <a
            href="https://docs.trigger.dev/getting-started"
            className="underline"
          >
            quick start guide
          </a>{" "}
          for running your workflow locally.
        </Body>
      </div>
    </>
  );
}

type WorkflowEventRule = NonNullable<
  ReturnType<typeof useCurrentWorkflow>
>["rules"][number];

function howToText(eventRule: WorkflowEventRule) {
  if (!eventRule.trigger) {
    return "This workflow hasn't been connected.";
  }
  switch (eventRule.trigger.type) {
    case "WEBHOOK":
      return "Run this workflow by triggering the webhook.";
    case "SCHEDULE":
      return "This workflow will run on the schedule you've defined.";
    case "CUSTOM_EVENT":
      return "This workflow will run when you send a custom event.";
    default:
      return "This workflow hasn't been connected.";
  }
}
