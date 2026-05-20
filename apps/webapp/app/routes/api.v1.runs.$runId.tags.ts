import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { AddTagsRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

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
    const bodyTags = typeof body.data.tags === "string" ? [body.data.tags] : body.data.tags;
    const nonEmptyTags = bodyTags.filter((t) => t.trim().length > 0);

    if (nonEmptyTags.length === 0) {
      return json({ message: "No new tags to add" }, { status: 200 });
    }

    const env = authenticationResult.environment;
    const outcome = await mutateWithFallback({
      runId: parsedParams.data.runId,
      environmentId: env.id,
      organizationId: env.organizationId,
      bufferPatch: { type: "append_tags", tags: nonEmptyTags },
      pgMutation: async (taskRun) => {
        const existing = taskRun.runTags ?? [];
        const newTags = nonEmptyTags.filter((t) => !existing.includes(t));

        if (existing.length + newTags.length > MAX_TAGS_PER_RUN) {
          return json(
            {
              error: `Runs can only have ${MAX_TAGS_PER_RUN} tags, you're trying to set ${
                existing.length + newTags.length
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
            id: taskRun.id,
            runtimeEnvironmentId: env.id,
          },
          data: { runTags: { push: newTags } },
        });
        return json({ message: `Successfully set ${newTags.length} new tags.` }, { status: 200 });
      },
      // Buffer-applied patch path. The mutateSnapshot Lua deduplicates
      // against existing snapshot tags atomically. MAX_TAGS_PER_RUN
      // enforcement is skipped on the buffered side — the drainer's
      // engine.trigger writes the PG row without enforcement either,
      // matching today's pre-buffer trigger semantics. A future
      // refinement could push the limit check into the Lua.
      synthesisedResponse: () =>
        json({ message: `Successfully set ${nonEmptyTags.length} new tags.` }, { status: 200 }),
      abortSignal: getRequestAbortSignal(),
    });

    if (outcome.kind === "not_found") {
      return json({ error: "Run not found" }, { status: 404 });
    }
    if (outcome.kind === "timed_out") {
      return json({ error: "Run materialisation timed out" }, { status: 503 });
    }
    return outcome.response;
  } catch (error) {
    logger.error("Failed to add run tags", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }
}
