import {
  BugAntIcon,
  CalendarIcon,
  ChevronRightIcon,
  IdentificationIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import type { CatalogIntegration } from "internal-catalog";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import CreateNewWorkflow, {
  CreateNewWorkflowNoWorkflows,
} from "~/components/CreateNewWorkflow";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import type { OrgWorkflow } from "~/hooks/useWorkflows";
import { useWorkflows } from "~/hooks/useWorkflows";
import { getIntegrations } from "~/models/integrations.server";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { getIntegration } from "~/utils/integrations";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  return typedjson({ integrations: getIntegrations(user.admin) });
};

export default function Page() {
  const { integrations } = useTypedLoaderData<typeof loader>();
  const workflows = useWorkflows();
  const currentOrganization = useCurrentOrganization();
  if (workflows === undefined || currentOrganization === undefined) {
    return <></>;
  }

  return (
    <Container>
      <Header1 className="mb-6">Workflows</Header1>
      {workflows.length === 0 ? (
        <CreateNewWorkflowNoWorkflows />
      ) : (
        <>
          <Header2 size="small" className="mb-2 text-slate-400">
            {workflows.length} active workflow{workflows.length > 1 ? "s" : ""}
          </Header2>
          <WorkflowList
            workflows={workflows}
            integrations={integrations}
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
  integrations,
  currentOrganizationSlug,
}: {
  workflows: OrgWorkflow[];
  integrations: CatalogIntegration[];
  currentOrganizationSlug: string;
}) {
  return (
    <List>
      {workflows.map((workflow) => {
        return (
          <li key={workflow.id}>
            <Link
              to={`/orgs/${currentOrganizationSlug}/workflows/${workflow.slug}`}
              className="block hover:bg-slate-850/50 transition"
            >
              <div className="flex items-center px-4 py-4 sm:px-6">
                <div className="min-w-0 flex-1 sm:flex sm:items-center sm:justify-between">
                  <div className="truncate">
                    <Header3 size="small" className="truncate font-medium">
                      {workflow.title}
                    </Header3>

                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex items-center text-sm text-slate-400">
                        <IdentificationIcon
                          className="mr-1.5 h-5 w-5 flex-shrink-0 text-slate-400"
                          aria-hidden="true"
                        />
                        <p className="mr-1">ID: {workflow.slug}</p>
                      </div>
                      <div className="flex items-center text-sm">
                        <CalendarIcon
                          className="mr-1.5 h-5 w-5 flex-shrink-0 text-slate-400"
                          aria-hidden="true"
                        />
                        <p className="mr-1 text-slate-400">Last modified:</p>
                        <time
                          className="text-slate-400"
                          dateTime={workflow.updatedAt.toISOString()}
                        >
                          {formatDateTime(workflow.updatedAt)}
                        </time>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <ApiLogoIcon
                      integration={getIntegration(
                        integrations,
                        workflow.service
                      )}
                    />
                    {workflow.externalServices.map((service) => (
                      <ApiLogoIcon
                        key={service.service}
                        integration={getIntegration(
                          integrations,
                          service.service
                        )}
                      />
                    ))}
                  </div>
                </div>
                <div className="ml-5 flex-shrink-0">
                  <ChevronRightIcon
                    className="h-5 w-5 text-slate-400"
                    aria-hidden="true"
                  />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
      <li>
        <Link to={`/`} className="block hover:bg-slate-850/40 transition">
          <div className="flex justify-between items-center flex-wrap lg:flex-nowrap px-4 py-4">
            <div className="flex items-center truncate justify-between">
              <div className="flex truncate">
                <TriggerTypeIcon className="flex-shrink-0 self-start h-24 w-24 mr-4" />
                <div className="mr-1 truncate">
                  <Header2 size="large" className="truncate text-slate-200">
                    Send to Slack on new domain
                  </Header2>
                  <div className="flex gap-2 mt-2">
                    <PillLabel label="webhook" />
                    <Header3 size="small" className="truncate text-slate-300">
                      GitHub Issues
                    </Header3>
                  </div>
                  <div className="flex flex-wrap gap-x-2 mt-2 items-baseline">
                    <WorkflowProperty
                      label="Repo"
                      content="trigger.dev/trigger.dev"
                    />
                    <WorkflowProperty
                      label="Property"
                      content="Another property"
                    />
                  </div>
                </div>
              </div>
              <ChevronRightIcon
                className="shrink-0 h-5 w-5 ml-5 text-slate-400 lg:hidden"
                aria-hidden="true"
              />
            </div>
            <div className="flex items-center flex-grow lg:flex-grow-0">
              <div className="flex flex-wrap-reverse justify-between w-full lg:justify-end gap-3 items-center mt-4 lg:mt-0">
                <div className="flex flex-col text-right">
                  <Body size="extra-small" className="text-slate-500">
                    Last run: Jan 5, 2023, 6:48 PM
                  </Body>
                  <Body size="extra-small" className="text-slate-500">
                    send-to-slack-on-new-domain
                  </Body>
                </div>
                <div className="flex gap-2 items-center">
                  <BugAntIcon className="h-9 w-9 p-1.5 bg-slate-850 rounded" />
                  <BugAntIcon className="h-9 w-9 p-1.5 bg-slate-850 rounded" />
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
    </List>
  );
}

function PillLabel({ label }: { label: string }) {
  return (
    <span className="px-2 py-1.5 text-xs font-semibold tracking-wider uppercase rounded text-slate-400 bg-slate-700">
      {label}
    </span>
  );
}

function WorkflowProperty({
  label,
  content,
  className,
}: {
  label: string;
  content: string;
  className?: string;
}) {
  return (
    <div className="flex items-baseline gap-x-1">
      <Body size="extra-small" className="uppercase text-slate-400">
        {label}
      </Body>
      <Body size="small" className="text-slate-400 truncate">
        {content}
      </Body>
    </div>
  );
}

function TriggerTypeIcon({ className }: { className?: string }) {
  return (
    <OctoKitty
      className={classNames("p-3 bg-slate-850 rounded-md", className)}
    />
  );
}
