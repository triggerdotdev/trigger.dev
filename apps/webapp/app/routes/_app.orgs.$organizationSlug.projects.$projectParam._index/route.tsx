import { JobItem, JobList } from "~/components/jobs/JobItem";
import { JobSkeleton } from "~/components/jobs/JobSkeleton";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Help } from "~/components/primitives/Help";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { ProjectJob, useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { jobPath } from "~/utils/pathBuilder";
import { useMemo, useState } from "react";
import { Input } from "~/components/primitives/Input";
import { Paragraph } from "~/components/primitives/Paragraph";

export const handle: Handle = {
  breadcrumb: {
    slug: "jobs",
  },
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const [searchText, setSearchText] = useState<string>("");

  const filteredJobs = useMemo(() => {
    if (searchText === "") {
      return project.jobs;
    }

    return project.jobs.filter((job) => {
      if (job.title.toLowerCase().includes(searchText.toLowerCase()))
        return true;
      if (job.event.title.toLowerCase().includes(searchText.toLowerCase()))
        return true;
      if (
        job.integrations.some((integration) =>
          integration.title.toLowerCase().includes(searchText.toLowerCase())
        )
      )
        return true;
      if (
        job.event.elements &&
        job.event.elements.some((element) =>
          element.text.toLowerCase().includes(searchText.toLowerCase())
        )
      )
        return true;

      return false;
    });
  }, [project.jobs, searchText]);

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
        <Help defaultOpen={project.jobs.length === 0}>
          <div className="flex h-full gap-4">
            <div className="grow">
              <div className="mb-2 flex items-center justify-between gap-x-2">
                {project.jobs.length === 0 ? (
                  <Header2>Your Jobs will appear here</Header2>
                ) : (
                  <Input
                    placeholder="Search Jobs"
                    variant="tertiary"
                    icon="search"
                    fullWidth={true}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                )}
                <HelpTrigger title="How do I create a Job?" />
              </div>
              {project.jobs.length > 0 ? (
                filteredJobs.length > 0 ? (
                  <JobList>
                    {filteredJobs.map((job) => (
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
                  <Paragraph variant="small" className="p-4">
                    No Jobs match {searchText}. Try a different search query.
                  </Paragraph>
                )
              ) : (
                <>
                  <JobList>
                    <JobSkeleton />
                  </JobList>
                </>
              )}
            </div>
            <HelpContent title="How to create a Job">
              <Paragraph>This is some help content</Paragraph>
            </HelpContent>
          </div>
        </Help>
      </PageBody>
    </PageContainer>
  );
}
