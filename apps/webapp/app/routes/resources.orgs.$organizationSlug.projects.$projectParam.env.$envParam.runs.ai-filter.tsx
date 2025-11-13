import { openai } from "@ai-sdk/openai";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { RunTagListPresenter } from "~/presenters/v3/RunTagListPresenter.server";
import { VersionListPresenter } from "~/presenters/v3/VersionListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import {
  AIRunFilterService,
  type QueryQueues,
  type QueryTags,
  type QueryTasks,
  type QueryVersions,
} from "~/v3/services/aiRunFilterService.server";

const RequestSchema = z.object({
  text: z.string().min(1),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  // Parse the request body
  const formData = await request.formData();
  const submission = RequestSchema.safeParse(Object.fromEntries(formData));

  if (!submission.success) {
    return json<{ success: false; error: string }>(
      {
        success: false,
        error: "Invalid request data",
      },
      { status: 400 }
    );
  }

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

  const { text } = submission.data;

  //Tags querying
  const queryTags: QueryTags = {
    query: async (search) => {
      const tagPresenter = new RunTagListPresenter();
      const tags = await tagPresenter.call({
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        name: search,
        page: 1,
        pageSize: 50,
        period: "30d",
      });
      return {
        tags: tags.tags,
      };
    },
  };

  const queryQueues: QueryQueues = {
    query: async (query, type) => {
      const queuePresenter = new QueueListPresenter();
      const queues = await queuePresenter.call({
        environment,
        query,
        page: 1,
        type,
      });
      return {
        queues: queues.success ? queues.queues.map((q) => q.name) : [],
      };
    },
  };

  const queryVersions: QueryVersions = {
    query: async (versionPrefix, isCurrent) => {
      const versionPresenter = new VersionListPresenter();
      const versions = await versionPresenter.call({
        environment,
        query: versionPrefix ? versionPrefix : undefined,
      });

      if (isCurrent) {
        const currentVersion = versions.versions.find((v) => v.isCurrent);
        if (currentVersion) {
          return {
            version: currentVersion.version,
          };
        }

        const newestVersion = versions.versions.at(0)?.version;
        if (newestVersion) {
          return {
            version: newestVersion,
          };
        }
      }

      return {
        versions: versions.versions.map((v) => v.version),
      };
    },
  };

  const queryTasks: QueryTasks = {
    query: async () => {
      const tasks = await getAllTaskIdentifiers($replica, environment.id);
      return {
        tasks,
      };
    },
  };

  if (!env.OPENAI_API_KEY) {
    return json(
      {
        success: false,
        error: "OpenAI API key is not configured",
      },
      { status: 400 }
    );
  }

  const service = new AIRunFilterService(
    {
      queryTags,
      queryVersions,
      queryQueues,
      queryTasks,
    },
    openai(env.AI_RUN_FILTER_MODEL ?? "gpt-4o-mini")
  );

  const [error, result] = await tryCatch(service.call(text, environment.id));
  if (error) {
    return json({ success: false, error: error.message }, { status: 400 });
  }

  return json(result);
}
