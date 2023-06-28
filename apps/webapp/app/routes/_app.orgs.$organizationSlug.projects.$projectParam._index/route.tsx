import { HowToSetupYourProject } from "~/components/helpContent/HelpContentText";
import { JobsTable } from "~/components/jobs/JobsTable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph, TextLink } from "~/components/primitives/Paragraph";
import { useFilterJobs } from "~/hooks/useFilterJobs";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
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
                {project.jobs.length === 0 && (
                  <div
                    className={
                      "flex w-full justify-center gap-x-4 rounded-md border border-dashed border-indigo-800 px-5 py-8"
                    }
                  >
                    <Paragraph variant="small">
                      Your Jobs will appear here.
                    </Paragraph>
                  </div>
                )}
                {project.jobs.length === 1 && (
                  <>
                    <JobsTable
                      jobs={filteredItems}
                      noResultsText={`No Jobs match ${filterText}. Try a different search
                query.`}
                    />
                    <a
                      href="https://trigger.dev/docs/documentation/quickstart#your-first-job"
                      target="_blank"
                      className="group my-3 flex w-full items-center justify-between rounded border border-slate-850 bg-midnight-850 px-5 py-4 text-dimmed transition hover:bg-slate-900"
                    >
                      <span className="flex items-center gap-x-2 transition group-hover:text-bright">
                        <NamedIcon
                          name="docs"
                          className="h-6 w-6 text-blue-500"
                        />
                        Create your first Job in code.
                      </span>
                      <NamedIcon
                        name="external-link"
                        className="h-5 w-5 transition group-hover:text-bright"
                      />
                    </a>
                  </>
                )}
                {project.jobs.length > 1 && (
                  <>
                    <JobsTable
                      jobs={filteredItems}
                      noResultsText={`No Jobs match ${filterText}. Try a different search
              query.`}
                    />
                    <div className="mb-4 flex w-full justify-end pt-2">
                      <LinkButton
                        variant="tertiary/small"
                        to="https://trigger.dev/docs/documentation/guides/create-a-job"
                        target="_blank"
                        TrailingIcon="external-link"
                      >
                        Create another Job
                      </LinkButton>
                    </div>
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
