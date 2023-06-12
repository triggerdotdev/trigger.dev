import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { c } from "tar";
import { JobsTable } from "~/components/jobs/JobsTable";
import { useIntegrationClient } from "~/hooks/useIntegrationClient";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientJobsPresenter } from "~/presenters/IntegrationClientJobsPresenter.server";
import { requireUserId } from "~/services/session.server";
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

  return (
    <JobsTable
      jobs={projectJobs}
      noResultsText={`No Jobs are currently using "${client.title}"`}
    />
  );
}
