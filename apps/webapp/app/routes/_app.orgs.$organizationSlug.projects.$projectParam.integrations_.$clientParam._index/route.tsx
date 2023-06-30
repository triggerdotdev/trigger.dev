import { useMatches } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { HowToUseThisIntegration } from "~/components/helpContent/HelpContentText";
import { JobSkeleton } from "~/components/jobs/JobSkeleton";
import { JobsTable } from "~/components/jobs/JobsTable";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { useFilterJobs } from "~/hooks/useFilterJobs";
import { useIntegrationClient } from "~/hooks/useIntegrationClient";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientJobsPresenter } from "~/presenters/IntegrationClientJobsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { IntegrationClientParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, clientParam } =
    IntegrationClientParamSchema.parse(params);

  const presenter = new IntegrationClientJobsPresenter();
  const { jobs } = await presenter.call({
    userId: userId,
    organizationSlug,
    projectSlug: projectParam,
    clientSlug: clientParam,
  });

  return typedjson({ jobs });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "integration-job",
  },
};

export default function Page() {
  const { jobs } = useTypedLoaderData<typeof loader>();
  const client = useIntegrationClient();
  const project = useProject();

  const projectJobs = project.jobs.filter((job) =>
    jobs.map((j) => j.id).includes(job.id)
  );

  const { filterText, setFilterText, filteredItems } =
    useFilterJobs(projectJobs);

  return (
    <Help defaultOpen={projectJobs.length === 0}>
      {(open) => (
        <div
          className={cn(
            "grid h-full gap-4",
            open ? "grid-cols-2" : "grid-cols-1"
          )}
        >
          <div className="grow">
            <div className="mb-2 flex items-center justify-between gap-x-2">
              {projectJobs.length === 0 ? (
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
            {projectJobs.length === 0 ? (
              <>
                <JobSkeleton />
              </>
            ) : (
              <JobsTable
                jobs={filteredItems}
                noResultsText={
                  projectJobs.length === 0
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
          </HelpContent>
        </div>
      )}
    </Help>
  );
}
