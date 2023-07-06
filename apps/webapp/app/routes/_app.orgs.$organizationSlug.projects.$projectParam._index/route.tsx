import Confetti from "react-confetti";
import { HowToSetupYourProject } from "~/components/helpContent/HelpContentText";
import { JobsTable } from "~/components/jobs/JobsTable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
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
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import useWindowSize from "react-use/lib/useWindowSize";
import { docsPath } from "~/utils/pathBuilder";

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

  const { width, height } = useWindowSize();

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
        {/* Todo: this confetti component needs to trigger when the example project is created, then never again. */}
        {/* <Confetti
          width={width}
          height={height}
          recycle={false}
          numberOfPieces={1000}
          colors={[
            "#E7FF52",
            "#41FF54",
            "rgb(245 158 11)",
            "rgb(22 163 74)",
            "rgb(37 99 235)",
            "rgb(67 56 202)",
            "rgb(219 39 119)",
            "rgb(225 29 72)",
            "rgb(217 70 239)",
          ]}
        /> */}
        <Help defaultOpen={project.jobs.length === 0}>
          {(open) => (
            <div
              className={cn(
                "grid h-fit gap-4",
                open ? "grid-cols-2" : "grid-cols-1"
              )}
            >
              <div>
                <div className="mb-2 flex items-center justify-between gap-x-2">
                  {project.jobs.length === 0 ? (
                    <Header2>Jobs</Header2>
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
                  <HelpTrigger title="How do I setup my Project?" />
                </div>
                {project.jobs.length === 0 ? (
                  <div
                    className={
                      "flex w-full justify-center gap-x-4 rounded-md border border-dashed border-indigo-800 px-5 py-8"
                    }
                  >
                    <Paragraph variant="small">
                      Your Jobs will appear here.
                    </Paragraph>
                  </div>
                ) : (
                  <>
                    <JobsTable
                      jobs={filteredItems}
                      noResultsText={`No Jobs match ${filterText}. Try a different search
              query.`}
                    />
                    {project.jobs.length === 1 ? (
                      <Callout
                        variant="docs"
                        to={docsPath("documentation/quickstart#your-first-job")}
                        className="my-3"
                      >
                        Create your first Job in code
                      </Callout>
                    ) : (
                      <Callout
                        variant="docs"
                        to={docsPath("documentation/guides/create-a-job")}
                        className="my-3"
                      >
                        Create another Job
                      </Callout>
                    )}
                  </>
                )}
              </div>
              <HelpContent title="How to setup your Project">
                <HowToSetupYourProject />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}
