import { JobSkeleton } from "~/components/jobs/JobSkeleton";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { runStatusTitle } from "~/components/runs/RunStatuses";
import { useOrganization } from "~/hooks/useOrganizations";
import { ProjectJob, useProject } from "~/hooks/useProject";
import { useTextFilter } from "~/hooks/useTextFilter";
import { JobRunStatus } from "~/models/job.server";
import { cn } from "~/utils/cn";
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

  const { filterText, setFilterText, filteredItems } =
    useTextFilter<ProjectJob>({
      items: project.jobs,
      filter: (job, text) => {
        if (job.title.toLowerCase().includes(text.toLowerCase())) return true;
        if (job.event.title.toLowerCase().includes(text.toLowerCase()))
          return true;
        if (
          job.integrations.some((integration) =>
            integration.title.toLowerCase().includes(text.toLowerCase())
          )
        )
          return true;
        if (
          job.elements &&
          job.elements.some((element) =>
            element.text.toLowerCase().includes(text.toLowerCase())
          )
        )
          return true;

        return false;
      },
    });

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
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                  />
                )}
                <HelpTrigger title="How do I create a Job?" />
              </div>
              {project.jobs.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Job</TableHeaderCell>
                      <TableHeaderCell>ID</TableHeaderCell>
                      <TableHeaderCell>Integrations</TableHeaderCell>
                      <TableHeaderCell>Properties</TableHeaderCell>
                      <TableHeaderCell>Last run</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredItems.length > 0 ? (
                      filteredItems.map((job) => {
                        const path = jobPath(organization, project, job);
                        return (
                          <TableRow key={job.id}>
                            <TableCell to={path}>
                              <span className="flex items-center gap-2">
                                <NamedIcon
                                  name={job.event.icon}
                                  className="h-8 w-8"
                                />
                                <LabelValueStack
                                  label={job.title}
                                  value={job.event.title}
                                  variant="primary"
                                />
                              </span>
                            </TableCell>
                            <TableCell to={path}>
                              <LabelValueStack
                                label={job.slug}
                                value={`v${job.version}`}
                                variant="primary"
                              />
                            </TableCell>
                            <TableCell to={path}>
                              {job.integrations.map((integration) => (
                                <SimpleTooltip
                                  key={integration.key}
                                  button={
                                    <NamedIcon
                                      name={integration.icon}
                                      className="h-6 w-6"
                                    />
                                  }
                                  content={`${integration.title}: ${integration.key}`}
                                />
                              ))}
                            </TableCell>
                            <TableCell to={path}>
                              {job.elements && (
                                <SimpleTooltip
                                  button={
                                    <div className="flex max-w-[200px] items-start justify-start gap-5 truncate">
                                      {job.elements.map((element, index) => (
                                        <LabelValueStack
                                          key={index}
                                          label={element.label}
                                          value={element.text}
                                          className=" last:truncate"
                                        />
                                      ))}
                                    </div>
                                  }
                                  content={
                                    <div className="flex flex-col gap-2">
                                      {job.elements.map((element, index) => (
                                        <LabelValueStack
                                          key={index}
                                          label={element.label}
                                          value={element.text}
                                        />
                                      ))}
                                    </div>
                                  }
                                />
                              )}
                            </TableCell>
                            <TableCell to={path}>
                              {job.lastRun ? (
                                <LabelValueStack
                                  label={
                                    <span
                                      className={classForJobStatus(
                                        job.lastRun.status
                                      )}
                                    >
                                      {runStatusTitle(job.lastRun.status)}
                                    </span>
                                  }
                                  value={
                                    <DateTime
                                      date={job.lastRun.createdAt}
                                      className={classForJobStatus(
                                        job.lastRun.status
                                      )}
                                    />
                                  }
                                />
                              ) : (
                                <LabelValueStack
                                  label={"Never run"}
                                  value={"–"}
                                />
                              )}
                            </TableCell>
                            <TableCellChevron to={path} />
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableBlankRow colSpan={6}>
                        <Paragraph
                          variant="small"
                          className="flex items-center justify-center"
                        >
                          No Jobs match {filterText}. Try a different search
                          query.
                        </Paragraph>
                      </TableBlankRow>
                    )}
                  </TableBody>
                </Table>
              ) : (
                <>
                  <JobSkeleton />
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

function classForJobStatus(status: JobRunStatus) {
  switch (status) {
    case "FAILURE":
    case "TIMED_OUT":
    case "WAITING_ON_CONNECTIONS":
    case "PENDING":
      return "text-rose-500";
    default:
      return "";
  }
}
