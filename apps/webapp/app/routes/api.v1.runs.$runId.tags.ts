import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { AddTagsRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

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

    const run = await prisma.taskRun.findFirst({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
      select: {
        runTags: true,
      },
    });

    const existingTags = run?.runTags ?? [];

    //remove duplicate tags from the new tags
    const bodyTags = typeof body.data.tags === "string" ? [body.data.tags] : body.data.tags;
    const newTags = bodyTags.filter((tag) => {
      if (tag.trim().length === 0) return false;
      return !existingTags.includes(tag);
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

    await prisma.taskRun.update({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
      data: {
        runTags: {
          push: newTags,
        },
      },
    });

    return json({ message: `Successfully set ${newTags.length} new tags.` }, { status: 200 });
  } catch (error) {
    logger.error("Failed to add run tags", { error });
    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
