import invariant from "tiny-invariant";
import { JobItem, JobList } from "~/components/jobs/JobItem";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { jobPath } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: {
    slug: "jobs",
  },
};

export default function Page() {
  const organization = useCurrentOrganization();
  const project = useCurrentProject();
  invariant(project, "Project must be defined");
  invariant(organization, "Organization must be defined");

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Jobs" />
          <PageButtons>
            {/* <LinkButton
              to={newProjectPath(currentOrganization)}
              variant="primary/small"
              shortcut="N"
            >
              Create a new project
            </LinkButton> */}
          </PageButtons>
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
