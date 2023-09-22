import { ProjectJob } from "~/hooks/useJobs";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { JobRunStatus } from "~/models/job.server";
import { jobPath, jobTestPath } from "~/utils/pathBuilder";
import { Button } from "../primitives/Buttons";
import { DateTime } from "../primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { LabelValueStack } from "../primitives/LabelValueStack";
import { NamedIcon } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import { PopoverMenuItem } from "../primitives/Popover";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";
import { SimpleTooltip } from "../primitives/Tooltip";
import { runStatusTitle } from "../runs/RunStatuses";
import { DeleteJobDialogContent } from "./DeleteJobModalContent";
import { JobStatusBadge } from "./JobStatusBadge";

export function JobsTable({ jobs, noResultsText }: { jobs: ProjectJob[]; noResultsText: string }) {
  const organization = useOrganization();
  const project = useProject();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Job</TableHeaderCell>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Integrations</TableHeaderCell>
          <TableHeaderCell>Properties</TableHeaderCell>
          <TableHeaderCell>Last run</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.length > 0 ? (
          jobs.map((job) => {
            const path = jobPath(organization, project, job);
            return (
              <TableRow key={job.id} className="group">
                <TableCell to={path}>
                  <span className="flex items-center gap-2">
                    <NamedIcon name={job.event.icon} className="h-8 w-8" />
                    <LabelValueStack
                      label={job.title}
                      value={
                        job.dynamic ? (
                          <span className="flex items-center gap-0.5">
                            <NamedIcon name="dynamic" className="h-4 w-4" />{" "}
                            <span className="uppercase">Dynamic:</span> {job.event.title}
                          </span>
                        ) : (
                          job.event.title
                        )
                      }
                      variant="primary"
                    />
                  </span>
                </TableCell>
                <TableCell to={path}>
                  <LabelValueStack label={job.slug} value={`v${job.version}`} variant="primary" />
                </TableCell>
                <TableCell to={path}>
                  {job.integrations.map((integration) => (
                    <SimpleTooltip
                      key={integration.key}
                      button={
                        <div className="relative">
                          <NamedIcon name={integration.icon} className="h-6 w-6" />
                          {integration.setupStatus === "MISSING_FIELDS" && (
                            <NamedIcon name="error" className="absolute -left-1 -top-1 h-4 w-4" />
                          )}
                        </div>
                      }
                      content={
                        <div>
                          <p className="mb-1 text-rose-400">
                            {integration.setupStatus === "MISSING_FIELDS" &&
                              "This integration requires configuration"}
                          </p>
                          <p>
                            {integration.title}: {integration.key}
                          </p>
                        </div>
                      }
                    />
                  ))}
                </TableCell>
                <TableCell to={path}>
                  {job.properties && (
                    <SimpleTooltip
                      button={
                        <div className="flex max-w-[200px] items-start justify-start gap-5 truncate">
                          {job.properties.map((property, index) => (
                            <LabelValueStack
                              key={index}
                              label={property.label}
                              value={property.text}
                              className=" last:truncate"
                            />
                          ))}
                        </div>
                      }
                      content={
                        <div className="flex flex-col gap-2">
                          {job.properties.map((property, index) => (
                            <LabelValueStack
                              key={index}
                              label={property.label}
                              value={property.text}
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
                        <span className={classForJobStatus(job.lastRun.status)}>
                          {runStatusTitle(job.lastRun.status)}
                        </span>
                      }
                      value={
                        <span className={classForJobStatus(job.lastRun.status)}>
                          <DateTime date={job.lastRun.createdAt} />
                        </span>
                      }
                    />
                  ) : (
                    <LabelValueStack label={"Never run"} value={"–"} />
                  )}
                </TableCell>
                <TableCell to={path}>
                  <JobStatusBadge
                    enabled={job.status === "ACTIVE"}
                    hasIntegrationsRequiringAction={job.hasIntegrationsRequiringAction}
                    hasRuns={job.lastRun !== undefined}
                  />
                </TableCell>
                <TableCellMenu isSticky>
                  <PopoverMenuItem to={path} title="View Job" icon="eye" />
                  <PopoverMenuItem
                    to={jobTestPath(organization, project, job)}
                    title="Test Job"
                    icon="beaker"
                  />

                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="menu-item" LeadingIcon="trash-can">
                        Delete Job
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DeleteJobDialogContent
                          id={job.id}
                          title={job.title}
                          slug={job.slug}
                          environments={job.environments}
                        />
                      </DialogHeader>
                    </DialogContent>
                  </Dialog>
                </TableCellMenu>
              </TableRow>
            );
          })
        ) : (
          <TableBlankRow colSpan={6}>
            <Paragraph variant="small" className="flex items-center justify-center">
              {noResultsText}
            </Paragraph>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}

function classForJobStatus(status: JobRunStatus) {
  switch (status) {
    case "FAILURE":
    case "TIMED_OUT":
    case "WAITING_ON_CONNECTIONS":
    case "PENDING":
    case "UNRESOLVED_AUTH":
    case "INVALID_PAYLOAD":
      return "text-rose-500";
    default:
      return "";
  }
}
