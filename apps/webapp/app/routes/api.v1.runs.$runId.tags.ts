import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { AddTagsRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createTag, getTagsForRunId, MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { runsDashboard } from "~/services/runsDashboardInstance.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return json(
      { error: "Invalid request parameters", issues: parsedParams.error.issues },
      { status: 400 }
    );
  }

  try {
    const anyBody = await request.json();

    const body = AddTagsRequestBody.safeParse(anyBody);
    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    const existingTags =
      (await getTagsForRunId({
        friendlyId: parsedParams.data.runId,
        environmentId: authenticationResult.environment.id,
      })) ?? [];

    //remove duplicate tags from the new tags
    const bodyTags = typeof body.data.tags === "string" ? [body.data.tags] : body.data.tags;
    const newTags = bodyTags.filter((tag) => {
      if (tag.trim().length === 0) return false;
      return !existingTags.map((t) => t.name).includes(tag);
    });

    if (existingTags.length + newTags.length > MAX_TAGS_PER_RUN) {
      return json(
        {
          error: `Runs can only have ${MAX_TAGS_PER_RUN} tags, you're trying to set ${
            existingTags.length + newTags.length
          }. These tags have not been set: ${newTags.map((t) => `'${t}'`).join(", ")}.`,
        },
        { status: 422 }
      );
    }

    if (newTags.length === 0) {
      return json({ message: "No new tags to add" }, { status: 200 });
    }

    //create tags
    let tagIds: string[] = existingTags.map((t) => t.id);
    if (newTags.length > 0) {
      for (const tag of newTags) {
        const tagRecord = await createTag({
          tag,
          projectId: authenticationResult.environment.projectId,
        });
        if (tagRecord) {
          tagIds.push(tagRecord.id);
        }
      }
    }

    const taskRun = await prisma.taskRun.update({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
      data: {
        tags: {
          connect: tagIds.map((id) => ({ id })),
        },
        runTags: {
          push: newTags,
        },
      },
    });

    runsDashboard.emit.runTagsUpdated({
      time: new Date(),
      run: {
        id: taskRun.id,
        tags: taskRun.runTags,
        status: taskRun.status,
        updatedAt: taskRun.updatedAt,
        createdAt: taskRun.createdAt,
      },
      organization: {
        id: authenticationResult.environment.organizationId,
      },
      project: {
        id: authenticationResult.environment.projectId,
      },
      environment: {
        id: authenticationResult.environment.id,
      },
    });

    return json({ message: `Successfully set ${newTags.length} new tags.` }, { status: 200 });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Internal Server Error" },
      { status: 500 }
    );
  }
}
