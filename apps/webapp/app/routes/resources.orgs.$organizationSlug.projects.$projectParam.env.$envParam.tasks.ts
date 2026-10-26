import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { getTaskIdentifiers } from "~/services/taskIdentifierRegistry.server";
import { logger } from "~/services/logger.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  try {
    const userId = await requireUserId(request);

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      throw new Response(undefined, {
        status: 404,
        statusText: "Project not found",
      });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) {
      throw new Response(undefined, {
        status: 404,
        statusText: "Environment not found",
      });
    }

    const tasks = await getTaskIdentifiers(environment.id);

    return {
      tasks: tasks
        .filter((task) => task.isInLatestDeployment)
        .map((task) => ({ slug: task.slug, triggerSource: task.triggerSource })),
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load tasks", {
      organizationSlug,
      projectParam,
      envParam,
      error,
    });
    throw error;
  }
}
