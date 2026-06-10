import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { AddTagsRequestBody } from "@trigger.dev/core/v3";
import type { BufferEntry } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { prisma } from "~/db.server";
import { MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";

// Pull the existing tags out of a buffer entry's serialised payload so
// the buffer-path response can dedup against them, matching the
// PG-path's `newTags.length` count rather than the pre-dedup input
// count. Returns null on any parse failure / shape mismatch so the
// caller can fall back gracefully.
function parseSnapshotTags(entry: BufferEntry | null): string[] | null {
  if (!entry) return null;
  try {
    const snapshot = JSON.parse(entry.payload) as { tags?: unknown };
    if (!Array.isArray(snapshot.tags)) return null;
    return snapshot.tags.filter((t): t is string => typeof t === "string");
  } catch {
    return null;
  }
}

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
    const outcome = await mutateWithFallback<Response>({
      runId: parsedParams.data.runId,
      environmentId: env.id,
      organizationId: env.organizationId,
      bufferPatch: { type: "append_tags", tags: nonEmptyTags, maxTags: MAX_TAGS_PER_RUN },
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
        // Publish a run-changed record with the NEW tag set so tag feeds reindex
        // (no-op unless enabled).
        publishChangeRecord({
          runId: taskRun.id,
          envId: env.id,
          tags: existing.concat(newTags),
          batchId: taskRun.batchId,
        });
        return json({ message: `Successfully set ${newTags.length} new tags.` }, { status: 200 });
      },
      // Buffer-applied patch path. The mutateSnapshot Lua deduplicates
      // against existing snapshot tags atomically and enforces
      // MAX_TAGS_PER_RUN via the `maxTags` we pass in `bufferPatch` —
      // matching the PG-path cap above so a buffered run can't exceed the
      // limit the trigger validator applies at creation.
      //
      // Dedup the success-count off the pre-mutation entry (already
      // fetched by mutateWithFallback's env-auth pre-check, so no extra
      // Redis read) so the message reports the same `newTags.length` the
      // PG path reports — not the pre-dedup request count, which would
      // give an inconsistent number across the buffered/materialised
      // boundary for the same input.
      synthesisedResponse: ({ bufferEntry }) => {
        const existing = parseSnapshotTags(bufferEntry);
        const newTagsCount = existing
          ? nonEmptyTags.filter((t) => !existing.includes(t)).length
          : nonEmptyTags.length;
        return json(
          { message: `Successfully set ${newTagsCount} new tags.` },
          { status: 200 }
        );
      },
      // Buffer rejected the append because it would exceed the cap. We
      // don't know the exact deduped overflow count here (the Lua does),
      // so report the limit rather than a precise "trying to set N".
      rejectedResponse: () =>
        json(
          { error: `Runs can only have ${MAX_TAGS_PER_RUN} tags.` },
          { status: 422 }
        ),
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
