import { parseWithZod } from "~/utils/conform";
import { json } from "@remix-run/node";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { resolveOrgIdFromProjectId } from "~/models/project.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { getSkewProtectionThresholdChoices } from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { sanitizeRedirectPath } from "~/utils";
import {
  changeSkewProtectionThresholdFromDashboard,
  MAX_THRESHOLD_VERSION_LENGTH,
  SkewProtectionThresholdError,
  ThresholdTaskId,
} from "~/v3/services/skewProtectionThreshold.server";

/** A task id: that task's own threshold. Absent: the environment's. */
const Task = ThresholdTaskId.optional();

const FormSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("set"),
    environmentId: z.string(),
    version: z.string().max(MAX_THRESHOLD_VERSION_LENGTH),
    task: Task,
    redirectUrl: z.string(),
  }),
  z.object({
    intent: z.literal("clear"),
    environmentId: z.string(),
    task: Task,
    redirectUrl: z.string(),
  }),
]);

const ParamSchema = z.object({
  projectId: z.string(),
});

const LoaderSearchParams = z.object({
  environmentId: z.string(),
  /** The task whose threshold the dialog sets. Absent: the environment's. */
  task: Task,
});

/**
 * The Upgrade sessions dialog's choices, loaded when it opens. The environment is looked up through the user's membership of the project's
 * organization, as the action does it.
 */
export const loader = dashboardLoader(
  {
    params: ParamSchema,
    searchParams: LoaderSearchParams,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromProjectId(params.projectId);
      // projectId: project-level roles count, as on Redeploy.
      return organizationId ? { organizationId, projectId: params.projectId } : {};
    },
    authorization: { action: "read", resource: { type: "deployments" } },
  },
  async ({ params, searchParams, user }) => {
    const environment = await $replica.runtimeEnvironment.findFirst({
      where: {
        id: searchParams.environmentId,
        projectId: params.projectId,
        organization: { members: { some: { userId: user.id } } },
      },
      select: { id: true },
    });
    if (!environment) {
      return json({ error: "Environment not found." }, { status: 404 });
    }

    return json({
      choices: await getSkewProtectionThresholdChoices($replica, {
        environmentId: environment.id,
        userId: user.id,
        task: searchParams.task,
      }),
    });
  }
);

export const action = dashboardAction(
  {
    params: ParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromProjectId(params.projectId);
      // projectId: project-level roles count, as on Redeploy.
      return organizationId ? { organizationId, projectId: params.projectId } : {};
    },
    // The same permission as Promote and Rollback on the Deployments page.
    authorization: { action: "write", resource: { type: "deployments" } },
  },
  async ({ request, params, user }) => {
    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: FormSchema });

    if (submission.status !== "success") {
      // Not echoed back: it can be any length.
      return json(submission.reply({ hideFields: ["version", "task"] }), { status: 400 });
    }

    const { intent, environmentId, redirectUrl: rawRedirect } = submission.value;
    const redirectUrl = sanitizeRedirectPath(rawRedirect);

    try {
      const { message } = await changeSkewProtectionThresholdFromDashboard(prisma, {
        user: { id: user.id, displayName: user.displayName, name: user.name },
        projectId: params.projectId,
        environmentId,
        change:
          submission.value.intent === "set"
            ? { type: "set", version: submission.value.version, task: submission.value.task }
            : { type: "clear", task: submission.value.task },
      });
      return redirectWithSuccessMessage(redirectUrl, request, message);
    } catch (error) {
      if (error instanceof SkewProtectionThresholdError) {
        return redirectWithErrorMessage(redirectUrl, request, error.message);
      }
      logger.error("Failed to change the skew protection threshold", {
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
        projectId: params.projectId,
        environmentId,
        intent,
      });
      return redirectWithErrorMessage(
        redirectUrl,
        request,
        "Couldn't change the skew protection threshold."
      );
    }
  }
);
