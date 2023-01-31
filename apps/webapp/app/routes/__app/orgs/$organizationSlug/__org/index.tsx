import {
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import {
  CreateNewWorkflow,
  CreateNewWorkflowNoWorkflows,
} from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import { Body } from "~/components/primitives/text/Body";
import { Header2, Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { runStatusLabel } from "~/components/runs/runStatus";
import { TriggerTypeIcon } from "~/components/triggers/TriggerIcons";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getIntegrationMetadatas } from "~/models/integrations.server";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import type { WorkflowListItem } from "~/models/workflowListPresenter.server";
import { WorkflowListPresenter } from "~/models/workflowListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  invariant(params.organizationSlug, "Organization slug is required");

  const providers = getIntegrationMetadatas(false);
  const currentEnv = await getRuntimeEnvironmentFromRequest(request);

  const presenter = new WorkflowListPresenter();

  try {
    const workflows = await presenter.data(params.organizationSlug, currentEnv);
    return typedjson({ workflows, providers });
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const { workflows, providers } = useTypedLoaderData<typeof loader>();
  const currentOrganization = useCurrentOrganization();
  if (currentOrganization === undefined) {
    return <></>;
  }

  return (
    <Container>
      <Title>Workflows</Title>
      {workflows.length === 0 ? (
        <>
          <SubTitle>Create your first workflow</SubTitle>
          <CreateNewWorkflowNoWorkflows providers={providers} />
        </>
      ) : (
        <>
          <SubTitle>
            {workflows.length} active workflow{workflows.length > 1 ? "s" : ""}
          </SubTitle>
          <WorkflowList
            workflows={workflows}
            currentOrganizationSlug={currentOrganization.slug}
          />
          <CreateNewWorkflow />
        </>
      )}
    </Container>
  );
}

function WorkflowList({
  workflows,
  currentOrganizationSlug,
}: {
  workflows: WorkflowListItem[];
  currentOrganizationSlug: string;
}) {
  return (
    <List>
      {workflows.map((workflow) => {
        return (
          <li key={workflow.id}>
            <Link
              to={`/orgs/${currentOrganizationSlug}/workflows/${workflow.slug}`}
              className={classNames(
                "block hover:bg-slate-850/40 transition",
                workflow.status === "DISABLED" ? workflowDisabled : ""
              )}
            >
              <div className="flex justify-between lg:items-center flex-col lg:flex-row flex-wrap lg:flex-nowrap pl-4 pr-4 py-4">
                <div className="flex items-center flex-1 justify-between">
                  <div className="relative flex items-center">
                    {workflow.status === "CREATED" && (
                      <ExclamationTriangleIcon className="absolute -top-1.5 -left-1.5 h-6 w-6 text-amber-400" />
                    )}
                    <div className="p-3 bg-slate-850 rounded-md flex-shrink-0 self-start h-20 w-20 mr-4">
                      <TriggerTypeIcon
                        type={workflow.trigger.type}
                        provider={workflow.integrations.source}
                      />
                    </div>
                    <div className="flex flex-col gap-1 mr-1 truncate">
                      <Header2
                        size="regular"
                        className="truncate text-slate-200"
                      >
                        {workflow.title}
                      </Header2>
                      <div className="flex gap-2 items-baseline">
                        <PillLabel label={workflow.trigger.typeTitle} />
                        <Header3
                          size="extra-small"
                          className="truncate text-slate-400"
                        >
                          {workflow.trigger.title}
                        </Header3>
                      </div>
                      <div className="flex flex-wrap gap-x-3 items-baseline">
                        {workflow.trigger.properties &&
                          workflow.trigger.properties.map((property) => (
                            <WorkflowProperty
                              key={property.key}
                              label={property.key}
                              content={`${property.value}`}
                            />
                          ))}
                      </div>
                    </div>
                  </div>
                  <ChevronRightIcon
                    className="shrink-0 h-5 w-5 ml-5 text-slate-400 lg:hidden"
                    aria-hidden="true"
                  />
                </div>
                <div className="flex items-center flex-grow lg:flex-grow-0">
                  <div className="flex flex-wrap-reverse justify-between w-full lg:justify-end gap-3 items-center mt-2 lg:mt-0">
                    <div className="flex flex-col text-left lg:text-right">
                      <Body size="extra-small" className="text-slate-500">
                        Last run: {lastRunDescription(workflow.lastRun)}
                      </Body>
                      <Body size="extra-small" className="text-slate-500">
                        {workflow.slug}
                      </Body>
                    </div>
                    <div className="flex gap-2 items-center">
                      {workflow.integrations.source && (
                        <ApiLogoIcon
                          integration={workflow.integrations.source}
                          size="regular"
                        />
                      )}
                      {workflow.integrations.services.map((service) => {
                        if (service === undefined) {
                          return null;
                        }
                        return (
                          <ApiLogoIcon
                            size="regular"
                            key={service.slug}
                            integration={service}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <ChevronRightIcon
                    className="shrink-0 h-5 w-5 ml-5 text-slate-400 hidden lg:block"
                    aria-hidden="true"
                  />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </List>
  );
}

function lastRunDescription(lastRun: WorkflowListItem["lastRun"]) {
  if (lastRun === null || lastRun === undefined) {
    return "Never";
  }

  if (lastRun.status === "SUCCESS") {
    if (lastRun.finishedAt) {
      return formatDateTime(lastRun.finishedAt);
    } else {
      return "Unknown";
    }
  }

  return runStatusLabel(lastRun.status);
}

function PillLabel({ label }: { label: string }) {
  return (
    <span className="px-1.5 py-1 text-[10px] font-semibold tracking-wide uppercase rounded text-slate-400 bg-slate-700">
      {label}
    </span>
  );
}

function WorkflowProperty({
  label,
  content,
}: {
  label: string;
  content: string;
}) {
  return (
    <div className="flex items-baseline gap-x-1">
      <Body size="extra-small" className="uppercase text-slate-500">
        {label}
      </Body>
      <Body size="small" className="text-slate-400 truncate">
        {content}
      </Body>
    </div>
  );
}

const workflowDisabled = "opacity-30";
