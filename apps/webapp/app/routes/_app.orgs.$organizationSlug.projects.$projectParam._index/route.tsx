import { JobItem, JobList } from "~/components/jobs/JobItem";
import { JobSkeleton } from "~/components/jobs/JobSkeleton";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
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
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={"job"}
              label={"Active Jobs"}
              value={project.jobs.length}
            />
          </PageInfoGroup>
        </PageInfoRow>
      </PageHeader>
      <PageBody>
        {project.jobs.length > 0 ? (
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
        ) : (
          <>
            <Header2 className="mb-2">Your Jobs will appear here</Header2>
            <JobList>
              <JobSkeleton />
            </JobList>
          </>
        )}
      </PageBody>
    </PageContainer>
  );
}
