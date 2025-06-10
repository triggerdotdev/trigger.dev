import { parse } from "@conform-to/zod";
import {
  BoltIcon,
  BoltSlashIcon,
  BookOpenIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { DialogDescription } from "@radix-ui/react-dialog";
import { Form, useLocation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
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
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
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
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
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
  const { projectParam, organizationSlug, envParam, scheduleParam } =
    v3ScheduleParams.parse(params);

  // Find the project scoped to the organization
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return redirectWithErrorMessage("/", request, "Environment not found");
  }

  const presenter = new ViewSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectId: project.id,
    friendlyId: scheduleParam,
    environmentId: environment.id,
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
  const { organizationSlug, projectParam, envParam, scheduleParam } =
    v3ScheduleParams.parse(params);

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
        { slug: envParam },
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
          v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
          request,
          `${scheduleParam} deleted`
        );
      } catch (e) {
        return redirectWithErrorMessage(
          v3SchedulePath(
            { slug: organizationSlug },
            { slug: projectParam },
            { slug: envParam },
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
            { slug: envParam },
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
            { slug: envParam },
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
  const environment = useEnvironment();

  const isUtc = schedule.timezone === "UTC";

  const isImperative = schedule.type === "IMPERATIVE";

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        isImperative ? "grid-rows-[2.5rem_1fr_3.25rem]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>{schedule.friendlyId}</Header2>
        <LinkButton
          to={`${v3SchedulesPath(organization, project, environment)}${location.search}`}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="space-y-3">
          <div className="p-3">
            <Property.Table>
              <Property.Item>
                <Property.Label>Schedule ID</Property.Label>
                <Property.Value>{schedule.friendlyId}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Task ID</Property.Label>
                <Property.Value>{schedule.taskIdentifier}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Type</Property.Label>
                <Property.Value>
                  <ScheduleTypeCombo type={schedule.type} className="text-sm" />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>CRON</Property.Label>
                <Property.Value>
                  <div className="space-y-2">
                    <InlineCode variant="extra-small">{schedule.cron}</InlineCode>
                    <Paragraph variant="small">{schedule.cronDescription}</Paragraph>
                  </div>
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Timezone</Property.Label>
                <Property.Value>{schedule.timezone}</Property.Value>
              </Property.Item>
              <Property.Item className="gap-1">
                <Property.Label>Environment</Property.Label>
                <Property.Value>
                  <div className="flex flex-col gap-2">
                    {schedule.environments.map((env) => (
                      <EnvironmentCombo key={env.id} environment={env} className="text-xs" />
                    ))}
                  </div>
                </Property.Value>
              </Property.Item>
              {isImperative && (
                <>
                  <Property.Item>
                    <Property.Label>External ID</Property.Label>
                    <Property.Value>
                      {schedule.externalId ? schedule.externalId : "–"}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Deduplication key</Property.Label>
                    <Property.Value>
                      {schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : "–"}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item className="gap-1.5">
                    <Property.Label>Status</Property.Label>
                    <Property.Value>
                      <EnabledStatus enabled={schedule.active} />
                    </Property.Value>
                  </Property.Item>
                </>
              )}
            </Property.Table>
          </div>
          <div className="flex flex-col gap-1">
            <Header3 className="pb-1 pl-3">Last 5 runs</Header3>
            <TaskRunsTable
              total={schedule.runs.length}
              hasFilters={false}
              filters={{
                tasks: [],
                versions: [],
                statuses: [],
                from: undefined,
                to: undefined,
              }}
              runs={schedule.runs}
              isLoading={false}
              variant="bright"
            />
          </div>
          <div className="flex flex-col gap-1 pt-2">
            <Header3 className="pb-1 pl-3">Next 5 runs</Header3>
            <Table variant="bright">
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
                    <TableBlankRow colSpan={isUtc ? 1 : 2}>
                      <PlaceholderText title="You found a bug" />
                    </TableBlankRow>
                  )
                ) : (
                  <TableBlankRow colSpan={isUtc ? 1 : 2}>
                    <PlaceholderText title="Schedule disabled" />
                  </TableBlankRow>
                )}
              </TableBody>
            </Table>
          </div>
          {!isImperative && (
            <div className="p-3">
              <InfoPanel
                title="Editing declarative schedules"
                icon={BookOpenIcon}
                iconClassName="text-indigo-500"
                variant="info"
                accessory={
                  <LinkButton
                    to="https://trigger.dev/docs/v3/tasks-scheduled"
                    variant="docs/small"
                    LeadingIcon={BookOpenIcon}
                  >
                    Schedules docs
                  </LinkButton>
                }
                panelClassName="max-w-full"
              >
                You can only edit a declarative schedule by updating your schedules.task and then
                running the CLI dev and deploy commands.
              </InfoPanel>
            </div>
          )}
        </div>
      </div>
      {isImperative && (
        <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
          <div className="flex items-center gap-2">
            <Form method="post">
              <Button
                type="submit"
                variant="tertiary/medium"
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
                  variant="danger/medium"
                  LeadingIcon={TrashIcon}
                  name="action"
                  value="delete"
                >
                  Delete
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-sm">
                <DialogHeader>Delete schedule</DialogHeader>
                <DialogDescription className="mt-3">
                  Are you sure you want to delete this schedule? This can't be reversed.
                </DialogDescription>
                <DialogFooter className="sm:justify-end">
                  <Form method="post">
                    <Button
                      type="submit"
                      variant="danger/medium"
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
              to={`${v3EditSchedulePath(organization, project, environment, schedule)}${
                location.search
              }`}
              LeadingIcon={PencilSquareIcon}
            >
              Edit schedule
            </LinkButton>
          </div>
        </div>
      )}
    </div>
  );
}
