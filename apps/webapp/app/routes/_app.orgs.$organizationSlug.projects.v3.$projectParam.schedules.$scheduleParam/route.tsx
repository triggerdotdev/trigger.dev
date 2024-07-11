import { parse } from "@conform-to/zod";
import { BoltIcon, BoltSlashIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/20/solid";
import { DialogDescription } from "@radix-ui/react-dialog";
import { Form, useLocation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { token } from "morgan";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel, EnvironmentLabels } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  v3EditSchedulePath,
  v3ScheduleParams,
  v3SchedulePath,
  v3SchedulesPath,
} from "~/utils/pathBuilder";
import { DeleteTaskScheduleService } from "~/v3/services/deleteTaskSchedule.server";
import { SetActiveOnTaskScheduleService } from "~/v3/services/setActiveOnTaskSchedule.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, scheduleParam } = v3ScheduleParams.parse(params);

  // Find the project scoped to the organization
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const presenter = new ViewSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectId: project.id,
    friendlyId: scheduleParam,
  });

  if (!result) {
    throw new Error("Schedule not found");
  }

  return typedjson({ schedule: result.schedule });
};

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
  }),
  z.object({
    action: z.literal("enable"),
  }),
  z.object({
    action: z.literal("disable"),
  }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, scheduleParam } = v3ScheduleParams.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  const project = await prisma.project.findFirst({
    where: {
      slug: projectParam,
    },
  });

  if (!project) {
    return redirectWithErrorMessage(
      v3SchedulePath(
        { slug: organizationSlug },
        { slug: projectParam },
        { friendlyId: scheduleParam }
      ),
      request,
      `No project found with slug ${projectParam}`
    );
  }

  switch (submission.value.action) {
    case "delete": {
      const deleteService = new DeleteTaskScheduleService();
      try {
        await deleteService.call({
          projectId: project.id,
          userId,
          friendlyId: scheduleParam,
        });
        return redirectWithSuccessMessage(
          v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }),
          request,
          `${scheduleParam} deleted`
        );
      } catch (e) {
        return redirectWithErrorMessage(
          v3SchedulePath(
            { slug: organizationSlug },
            { slug: projectParam },
            { friendlyId: scheduleParam }
          ),
          request,
          `${scheduleParam} could not be deleted: ${
            e instanceof Error ? e.message : JSON.stringify(e)
          }`
        );
      }
    }
    case "enable":
    case "disable": {
      const service = new SetActiveOnTaskScheduleService();
      const active = submission.value.action === "enable";
      try {
        await service.call({
          projectId: project.id,
          userId,
          friendlyId: scheduleParam,
          active,
        });
        return redirectWithSuccessMessage(
          v3SchedulePath(
            { slug: organizationSlug },
            { slug: projectParam },
            { friendlyId: scheduleParam }
          ),
          request,
          `${scheduleParam} ${active ? "enabled" : "disabled"}`
        );
      } catch (e) {
        return redirectWithErrorMessage(
          v3SchedulePath(
            { slug: organizationSlug },
            { slug: projectParam },
            { friendlyId: scheduleParam }
          ),
          request,
          `${scheduleParam} could not be ${active ? "enabled" : "disabled"}: ${
            e instanceof Error ? e.message : JSON.stringify(e)
          }`
        );
      }
    }
  }
};

function PlaceholderText({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}

export default function Page() {
  const { schedule } = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();

  const isUtc = schedule.timezone === "UTC";

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>{schedule.friendlyId}</Header2>
        <LinkButton
          to={`${v3SchedulesPath(organization, project)}${location.search}`}
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
              <Property label="Timezone">{schedule.timezone}</Property>
              <Property label="Environments">
                <EnvironmentLabels size="small" environments={schedule.environments} />
              </Property>
              <Property label="External ID">
                {schedule.externalId ? schedule.externalId : "–"}
              </Property>
              <Property label="Deduplication key">
                {schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : "–"}
              </Property>
              <Property label="Status">
                <EnabledStatus enabled={schedule.active} />
              </Property>
            </PropertyTable>
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
              />
            </div>
            <div className="flex flex-col gap-1">
              <Header3>Next 5 runs</Header3>
              <Table>
                <TableHeader>
                  <TableRow>
                    {!isUtc && <TableHeaderCell>{schedule.timezone}</TableHeaderCell>}
                    <TableHeaderCell>UTC</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedule.active ? (
                    schedule.nextRuns.length ? (
                      schedule.nextRuns.map((run, index) => (
                        <TableRow key={index}>
                          {!isUtc && (
                            <TableCell>
                              <DateTime date={run} timeZone={schedule.timezone} />
                            </TableCell>
                          )}
                          <TableCell>
                            <DateTime date={run} timeZone="UTC" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableBlankRow colSpan={1}>
                        <PlaceholderText title="You found a bug" />
                      </TableBlankRow>
                    )
                  ) : (
                    <TableBlankRow colSpan={1}>
                      <PlaceholderText title="Schedule disabled" />
                    </TableBlankRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
        <div className="flex items-center gap-4">
          <Form method="post">
            <Button
              type="submit"
              variant="minimal/medium"
              LeadingIcon={schedule.active ? BoltSlashIcon : BoltIcon}
              leadingIconClassName={schedule.active ? "text-dimmed" : "text-success"}
              name="action"
              value={schedule.active ? "disable" : "enable"}
            >
              {schedule.active ? "Disable" : "Enable"}
            </Button>
          </Form>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                type="submit"
                variant="minimal/medium"
                LeadingIcon={TrashIcon}
                leadingIconClassName="text-error"
                className="text-error"
                name="action"
                value="delete"
              >
                Delete
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>Delete schedule</DialogHeader>
              <DialogDescription>
                Are you sure you want to delete this schedule? This can't be reversed.
              </DialogDescription>
              <DialogFooter>
                <Form method="post">
                  <Button
                    type="submit"
                    variant="danger/small"
                    LeadingIcon={TrashIcon}
                    name="action"
                    value="delete"
                  >
                    Delete
                  </Button>
                </Form>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <div className="flex items-center gap-4">
          <LinkButton
            variant="tertiary/medium"
            to={`${v3EditSchedulePath(organization, project, schedule)}${location.search}`}
            LeadingIcon={PencilSquareIcon}
          >
            Edit schedule
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
