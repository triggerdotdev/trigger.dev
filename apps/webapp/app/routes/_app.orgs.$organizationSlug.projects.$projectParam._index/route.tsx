import { JobItem, JobList } from "~/components/jobs/JobItem";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { jobPath } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: {
    slug: "jobs",
  },
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Jobs" />
        </PageTitleRow>
        <PageDescription>{project.jobs.length} Jobs</PageDescription>
      </PageHeader>
      <PageBody>
        <JobList>
          {project.jobs.map((job) => (
            <JobItem
              key={job.id}
              to={jobPath(organization, project, job)}
              icon={job.event.icon}
              title={job.title}
              trigger={job.event.title}
              id={job.slug}
              elements={job.event.elements ?? []}
              lastRun={job.lastRun}
              integrations={job.integrations}
            />
          ))}
        </JobList>
      </PageBody>
    </PageContainer>
  );
}
