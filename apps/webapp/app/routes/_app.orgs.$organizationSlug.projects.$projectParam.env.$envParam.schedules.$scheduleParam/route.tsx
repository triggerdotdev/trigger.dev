import { parseWithZod } from "~/utils/conform";
import { useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs, json, redirect } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { LinkButton } from "~/components/primitives/Buttons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { requireUserId } from "~/services/session.server";
import {
  v3EnvironmentPath,
  v3ScheduledTaskSchedulePath,
  v3ScheduleParams,
  v3SchedulePath,
} from "~/utils/pathBuilder";
import { DeleteTaskScheduleService } from "~/v3/services/deleteTaskSchedule.server";
import { SetActiveOnTaskScheduleService } from "~/v3/services/setActiveOnTaskSchedule.server";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta(({ params }) => [params.scheduleParam ?? "Schedule", "Schedules"]);

/**
 * A schedule's old address. Its page is now under its task, so a visit goes there. The action
 * below stays: the schedule page posts its Enable, Disable and Delete here.
 */
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

  const result = await new ViewSchedulePresenter().call({
    userId,
    projectId: project.id,
    friendlyId: scheduleParam,
    environmentId: environment.id,
    // Only the schedule's task is needed, to build its page's address.
    includeRunHistory: false,
    nextRunCount: 0,
  });

  if (result) {
    return redirect(
      v3ScheduledTaskSchedulePath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        result.schedule.taskIdentifier,
        result.schedule
      )
    );
  }

  // A schedule that is gone (a link to one since deleted) gets the not-found message below.
  return typedjson({ schedule: null });
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

export const action = dashboardAction(
  {
    params: v3ScheduleParams,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: {
      action: "write",
      resource: { type: "tasks" },
      message: "With your current role, you can't manage schedules.",
    },
  },
  async ({ request, params, user }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam, scheduleParam } = params;

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    // `_format=json` → return JSON instead of redirecting; caller stays put.
    const wantsJson = formData.get("_format") === "json";

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);

    if (!project) {
      const message = `No project found with slug ${projectParam}`;
      if (wantsJson) {
        return json({ ok: false as const, message }, { status: 404 });
      }
      return redirectWithErrorMessage(
        v3SchedulePath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam },
          { friendlyId: scheduleParam }
        ),
        request,
        message
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
          if (wantsJson) {
            return json({ ok: true as const, message: `${scheduleParam} deleted` });
          }
          return redirectWithSuccessMessage(
            v3EnvironmentPath(
              { slug: organizationSlug },
              { slug: projectParam },
              { slug: envParam }
            ),
            request,
            `${scheduleParam} deleted`
          );
        } catch (e) {
          const message = `${scheduleParam} could not be deleted: ${
            e instanceof Error ? e.message : JSON.stringify(e)
          }`;
          if (wantsJson) {
            return json({ ok: false as const, message }, { status: 500 });
          }
          return redirectWithErrorMessage(
            v3SchedulePath(
              { slug: organizationSlug },
              { slug: projectParam },
              { slug: envParam },
              { friendlyId: scheduleParam }
            ),
            request,
            message
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
          if (wantsJson) {
            return json({ ok: true as const, active });
          }
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
          const message = e instanceof Error ? e.message : JSON.stringify(e);
          if (wantsJson) {
            return json({ ok: false as const, message }, { status: 500 });
          }
          return redirectWithErrorMessage(
            v3SchedulePath(
              { slug: organizationSlug },
              { slug: projectParam },
              { slug: envParam },
              { friendlyId: scheduleParam }
            ),
            request,
            `${scheduleParam} could not be ${active ? "enabled" : "disabled"}: ${message}`
          );
        }
      }
    }
  }
);

export default function Page() {
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background-bright p-6">
      <p className="text-sm text-text-bright">Schedule not found.</p>
      <LinkButton
        to={`${v3EnvironmentPath(organization, project, environment)}${location.search}`}
        variant="secondary/small"
      >
        Back to tasks
      </LinkButton>
    </div>
  );
}
