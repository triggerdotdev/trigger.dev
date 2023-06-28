import { HowToCreateAJob } from "~/components/helpContent/HelpContentText";
import { JobSkeleton } from "~/components/jobs/JobSkeleton";
import { JobsTable } from "~/components/jobs/JobsTable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useFilterJobs } from "~/hooks/useFilterJobs";
import { useOrganization } from "~/hooks/useOrganizations";
import { ProjectJob, useProject } from "~/hooks/useProject";
import { useTextFilter } from "~/hooks/useTextFilter";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: {
    slug: "jobs",
  },
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();

  const { filterText, setFilterText, filteredItems } = useFilterJobs(
    project.jobs
  );

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
          {(open) => (
            <div
              className={cn(
                "grid h-full gap-4",
                open ? "grid-cols-2" : "grid-cols-1"
              )}
            >
              <div>
                <div className="mb-2 flex items-center justify-between gap-x-2">
                  {project.jobs.length === 0 ? (
                    <Header2>Your Jobs will appear here</Header2>
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
                  <HelpTrigger title="How do I create a Job?" />
                </div>
                {project.jobs.length > 0 ? (
                  <JobsTable
                    jobs={filteredItems}
                    noResultsText={`No Jobs match ${filterText}. Try a different search
                query.`}
                  />
                ) : (
                  <>
                    <JobSkeleton />
                  </>
                )}
              </div>
              <HelpContent title="How to create a Job">
                <HowToCreateAJob />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}
