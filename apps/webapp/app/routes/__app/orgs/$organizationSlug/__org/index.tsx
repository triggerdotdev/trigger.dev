import {
  CalendarIcon,
  ChevronRightIcon,
  IdentificationIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import CreateNewWorkflow from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { Header1 } from "~/components/primitives/text/Headers";
import { useCurrentOrganizationSlug } from "~/hooks/useOrganizations";
import { useWorkflows } from "~/hooks/useWorkflows";
import type { Workflow } from "~/models/workflow.server";
import logoGithub from "~/assets/images/integrations/logo-github.png";
import logoTrello from "~/assets/images/integrations/logo-trello.png";
import logoAirtable from "~/assets/images/integrations/logo-airtable.png";
import { formatDateTime } from "~/utils";

export default function Page() {
  const workflows = useWorkflows();
  const currentOrganizationSlug = useCurrentOrganizationSlug();
  if (workflows === undefined || currentOrganizationSlug === undefined) {
    return <></>;
  }

  return (
    <Container>
      {workflows.length === 0 ? (
        <></>
      ) : (
        <>
          <Header1 className="mb-3">Workflows</Header1>
          <WorkflowList
            workflows={workflows}
            currentOrganizationSlug={currentOrganizationSlug}
          />
        </>
      )}
      <CreateNewWorkflow />
    </Container>
  );
}

function WorkflowList({
  workflows,
  currentOrganizationSlug,
}: {
  workflows: Workflow[];
  currentOrganizationSlug: string;
}) {
  return (
    <div className="overflow-hidden bg-slate-850 shadow sm:rounded-md mb-10">
      <ul className="divide-y divide-slate-800">
        {workflows.map((workflow) => {
          return (
            <li key={workflow.id}>
              <Link
                to={`/orgs/${currentOrganizationSlug}/workflows/${workflow.slug}`}
                className="block hover:bg-slate-900 transition"
              >
                <div className="flex items-center px-4 py-4 sm:px-6">
                  <div className="min-w-0 flex-1 sm:flex sm:items-center sm:justify-between">
                    <div className="truncate">
                      <p className="truncate font-medium text-lg">
                        {workflow.title}
                      </p>

                      <div className="mt-2 flex flex-col gap-2">
                        <div className="flex items-center text-sm text-slate-500">
                          <IdentificationIcon
                            className="mr-1.5 h-5 w-5 flex-shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                          <p className="mr-1">ID: {workflow.id}</p>
                        </div>
                        <div className="flex items-center text-sm text-slate-500">
                          <CalendarIcon
                            className="mr-1.5 h-5 w-5 flex-shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                          <p className="mr-1">Last modified:</p>
                          <time
                            //TODO: Fix this so dates come in as dates, not strings
                            dateTime={workflow.updatedAt.toISOString()}
                          >
                            {formatDateTime(workflow.updatedAt)}
                          </time>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <img
                        className="h-8 w-8"
                        src={logoGithub}
                        alt="Github integration logo"
                      />
                      <img
                        className="h-8 w-8"
                        src={logoAirtable}
                        alt="Github integration logo"
                      />
                      <img
                        className="h-8 w-8"
                        src={logoTrello}
                        alt="Github integration logo"
                      />
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
      </ul>
    </div>
  );
}
