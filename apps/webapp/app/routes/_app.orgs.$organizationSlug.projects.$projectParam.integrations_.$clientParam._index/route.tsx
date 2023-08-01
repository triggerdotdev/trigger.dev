import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { HowToUseThisIntegration } from "~/components/helpContent/HelpContentText";
import { JobSkeleton } from "~/components/jobs/JobSkeleton";
import { JobsTable } from "~/components/jobs/JobsTable";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { useFilterJobs } from "~/hooks/useFilterJobs";
import { useIntegrationClient } from "~/hooks/useIntegrationClient";
import { JobListPresenter } from "~/presenters/JobListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  IntegrationClientParamSchema,
  docsIntegrationPath,
  trimTrailingSlash,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, clientParam } =
    IntegrationClientParamSchema.parse(params);

  const jobsPresenter = new JobListPresenter();

  const jobs = await jobsPresenter.call({
    userId,
    projectSlug: projectParam,
    organizationSlug,
    integrationSlug: clientParam,
  });

  return typedjson({ jobs });
};

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Jobs" />,
};

export default function Page() {
  const { jobs } = useTypedLoaderData<typeof loader>();
  const client = useIntegrationClient();

  const { filterText, setFilterText, filteredItems } = useFilterJobs(jobs);

  return (
    <Help defaultOpen={jobs.length === 0}>
      {(open) => (
        <div className={cn("grid h-full gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
          <div className="grow">
            <div className="mb-2 flex items-center justify-between gap-x-2">
              {jobs.length === 0 ? (
                <Header2>Jobs using this integration will appear here</Header2>
              ) : (
                <Input
                  placeholder="Search Jobs"
                  variant="tertiary"
                  icon="search"
                  fullWidth={true}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
              )}
              <HelpTrigger title="How do I use this integration?" />
            </div>
            {jobs.length === 0 ? (
              <>
                <JobSkeleton />
              </>
            ) : (
              <JobsTable
                jobs={filteredItems}
                noResultsText={
                  jobs.length === 0
                    ? `No Jobs are currently using "${client.title}"`
                    : `No Jobs found for "${filterText}"`
                }
              />
            )}
          </div>
          <HelpContent title="How to use this Integration">
            <HowToUseThisIntegration
              integration={{
                name: client.integration.name,
                identifier: client.integrationIdentifier,
                packageName: client.integration.packageName,
              }}
              integrationClient={client}
              help={client.help}
            />
            <Callout variant="docs" to={docsIntegrationPath(client.integration.identifier)}>
              View the docs to learn more about using the {client.integration.name} Integration.
            </Callout>
          </HelpContent>
        </div>
      )}
    </Help>
  );
}
