import { parse } from "@conform-to/zod";
import { useLocation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { LinkButton } from "~/components/primitives/Buttons";
import { ScheduleInspector } from "~/components/schedules/ScheduleInspector";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { v3EnvironmentPath, v3ScheduleParams, v3SchedulePath } from "~/utils/pathBuilder";
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

  // Return null (not a 404 throw) so fetcher-driven hosts (e.g. the sheet
  // running this loader after a delete-in-flight) don't surface a
  // page-level error boundary. The standalone Page below renders a
  // not-found message when `schedule` is null.
  return typedjson({ schedule: result?.schedule ?? null });
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

  // `_format=json` → return JSON instead of redirecting; caller stays put.
  const wantsJson = formData.get("_format") === "json";

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
        if (wantsJson) {
          return json({ ok: true as const, message: `${scheduleParam} deleted` });
        }
        return redirectWithSuccessMessage(
          v3EnvironmentPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
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
};

export default function Page() {
  const { schedule } = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (!schedule) {
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

  return (
    <ScheduleInspector
      schedule={schedule}
      headerActions={
        <LinkButton
          to={`${v3EnvironmentPath(organization, project, environment)}${location.search}`}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      }
    />
  );
}
