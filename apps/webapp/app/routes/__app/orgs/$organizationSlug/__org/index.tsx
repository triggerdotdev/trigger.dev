import {
  CalendarIcon,
  ChevronRightIcon,
  IdentificationIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { CatalogIntegration } from "internal-catalog";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import CreateNewWorkflow from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import type { OrgWorkflow } from "~/hooks/useWorkflows";
import { useWorkflows } from "~/hooks/useWorkflows";
import { getIntegrations } from "~/models/integrations.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { getIntegration } from "~/utils/integrations";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  return typedjson({ integrations: getIntegrations() });
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
        <></>
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
        </>
      )}
      <CreateNewWorkflow />
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
    </List>
  );
}
