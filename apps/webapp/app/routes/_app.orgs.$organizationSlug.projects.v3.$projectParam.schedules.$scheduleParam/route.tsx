import {
  BoltSlashIcon,
  CheckCircleIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import cronstrue from "cronstrue";
import { H } from "highlight.run";
import { CheckCircle } from "lucide-react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3ScheduleParams, v3SchedulesPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, scheduleParam } = v3ScheduleParams.parse(params);

  const presenter = new ViewSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
    friendlyId: scheduleParam,
  });

  if (!result) {
    throw new Error("Schedule not found");
  }

  return typedjson({ schedule: result.schedule });
};

export default function Page() {
  const { schedule } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_2.5rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>{schedule.friendlyId}</Header2>
        <LinkButton
          to={v3SchedulesPath(organization, project)}
          variant="minimal/medium"
          LeadingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
        />
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="p-3">
          <div className="space-y-3">
            <PropertyTable>
              <Property label="Schedule ID">{schedule.friendlyId}</Property>
              <Property label="Task ID">{schedule.taskIdentifier}</Property>
              <Property label="CRON (UTC)" labelClassName="self-start">
                <div className="space-y-2">
                  <InlineCode variant="extra-small">{schedule.cron}</InlineCode>
                  <Paragraph variant="small">{schedule.cronDescription}</Paragraph>
                </div>
              </Property>
              <Property label="Environments">
                <div className="flex flex-wrap gap-1">
                  {schedule.environments.map((env) => (
                    <EnvironmentLabel
                      key={env.id}
                      size="small"
                      environment={env}
                      userName={env.userName}
                    />
                  ))}
                </div>
              </Property>
              <Property label="External ID">
                {schedule.externalId ? schedule.externalId : "–"}
              </Property>
              <Property label="Deduplication key">
                {schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : "–"}
              </Property>
              <Property label="Status">
                {schedule.active ? (
                  <div className="flex items-center gap-1 text-xs text-success">
                    <CheckCircleIcon className="h-4 w-4" />
                    Enabled
                  </div>
                ) : (
                  <div className="text-dimmed flex items-center gap-1 text-xs">
                    <BoltSlashIcon className="h-4 w-4" />
                    Disabled
                  </div>
                )}
              </Property>
            </PropertyTable>
            <div className="flex flex-col gap-1">
              <Header3>Next 5 runs</Header3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>UTC</TableHeaderCell>
                    <TableHeaderCell>Local time</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedule.nextRuns.map((run, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        <DateTime date={run} timeZone="UTC" />
                      </TableCell>
                      <TableCell>
                        <DateTime date={run} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col gap-1">
              <Header3>Last 5 runs</Header3>
              <TaskRunsTable
                total={schedule.runs.length}
                hasFilters={false}
                filters={{
                  tasks: [],
                  versions: [],
                  statuses: [],
                  environments: [],
                  from: undefined,
                  to: undefined,
                }}
                runs={schedule.runs}
                isLoading={false}
                currentUser={user}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
        <div className="flex items-center gap-4">
          <Button
            type="submit"
            variant="minimal/medium"
            LeadingIcon={TrashIcon}
            leadingIconClassName="text-error"
            className="text-error"
          >
            Delete
          </Button>
        </div>
        <div className="flex items-center gap-4">
          <LinkButton variant="tertiary/medium" to="" LeadingIcon={PencilSquareIcon}>
            Edit schedule
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
