import { c } from "tar";
import { JobsTable } from "~/components/jobs/JobsTable";
import { useIntegrationClient } from "~/hooks/useIntegrationClient";
import { useProject } from "~/hooks/useProject";

export default function Page() {
  const project = useProject();
  const client = useIntegrationClient();
  const jobs = project.jobs.filter((j) => client.jobs.includes(j.id));

  return (
    <JobsTable
      jobs={jobs}
      noResultsText={`No Jobs are currently using "${client.title}"`}
    />
  );
}
