import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { AddTagsRequestBody, RemoveTagsRequestBody } from "@trigger.dev/core/v3";
import type { BufferEntry } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { prisma } from "~/db.server";
import { MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { type AuthenticatedEnvironment, authenticateApiRequest } from "~/services/apiAuth.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import { runStore } from "~/v3/runStore.server";

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

type ResolvedRequest =
  | { kind: "ok"; environment: AuthenticatedEnvironment; runId: string }
  | { kind: "error"; response: Response };

// Auth + params, shared by both methods. Secret-key auth only, deliberately: adding
// an RBAC `authorization` gate here would change behaviour for narrowly-scoped JWTs.
async function resolveRequest(
  request: Request,
  params: ActionFunctionArgs["params"]
): Promise<ResolvedRequest> {
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return {
      kind: "error",
      response: json({ error: "Invalid or Missing API Key" }, { status: 401 }),
    };
  }

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return {
      kind: "error",
      response: json(
        { error: "Invalid request parameters", issues: parsedParams.error.issues },
        { status: 400 }
      ),
    };
  }

  return {
    kind: "ok",
    environment: authenticationResult.environment,
    runId: parsedParams.data.runId,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  switch (request.method.toUpperCase()) {
    case "POST":
      return addRunTags(request, params);
    case "DELETE":
      return removeRunTags(request, params);
    default:
      return json({ error: "Method Not Allowed" }, { status: 405 });
  }
}

async function addRunTags(request: Request, params: ActionFunctionArgs["params"]) {
  const resolved = await resolveRequest(request, params);
  if (resolved.kind === "error") {
    return resolved.response;
  }
  const { environment: env, runId } = resolved;

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

    const outcome = await mutateWithFallback<Response>({
      runId,
      environmentId: env.id,
      organizationId: env.organizationId,
      bufferPatch: { type: "append_tags", tags: nonEmptyTags, maxTags: MAX_TAGS_PER_RUN },
      pgMutation: async (taskRun) => {
        let existing = taskRun.runTags ?? [];
        let newTags = nonEmptyTags.filter((t) => !existing.includes(t));

        if (newTags.length < nonEmptyTags.length) {
          // At least one requested tag looks like it's already on the run. But `taskRun`
          // normally comes from the READ REPLICA, so "the run already has this tag" can
          // be replication lag rather than the truth -- and now that `tags.delete()`
          // exists the replica can be stale in the direction that LOSES a write:
          // `tags.delete("x")` immediately followed by `tags.add("x")` is an ordinary
          // pattern, and a replica still carrying the deleted "x" would make us dedup it
          // away and answer 200 with the run left untagged. Confirm against the primary
          // before skipping any tag, mirroring the removal path's no-op confirmation.
          //
          // Passing the writer as the read client makes the routing store read the
          // OWNING store's primary, so this is read-your-writes for a run on either
          // database. Only an apparent duplicate pays for the extra primary read: a
          // plain add of genuinely-new tags takes the replica row straight to the write.
          // When the tags really are present the fresh read agrees and we still skip.
          const fresh = await runStore.findRun(
            { id: taskRun.id, runtimeEnvironmentId: env.id },
            { select: { runTags: true } },
            prisma
          );

          // The run vanished (or moved environment) between the replica read and here.
          if (!fresh) {
            return json({ error: "Run not found" }, { status: 404 });
          }

          existing = fresh.runTags ?? [];
          newTags = nonEmptyTags.filter((t) => !existing.includes(t));
        }

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
        const updated = await runStore.pushTags(
          taskRun.id,
          newTags,
          { runtimeEnvironmentId: env.id },
          prisma
        );
        // Publish a run-changed record with the NEW tag set so tag feeds reindex
        // (no-op unless enabled). updatedAt is the read-your-writes watermark.
        publishChangeRecord({
          runId: taskRun.id,
          envId: env.id,
          tags: existing.concat(newTags),
          batchId: taskRun.batchId,
          updatedAtMs: updated.updatedAt.getTime(),
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
        return json({ message: `Successfully set ${newTagsCount} new tags.` }, { status: 200 });
      },
      // Buffer rejected the append because it would exceed the cap. We
      // don't know the exact deduped overflow count here (the Lua does),
      // so report the limit rather than a precise "trying to set N".
      rejectedResponse: () =>
        json({ error: `Runs can only have ${MAX_TAGS_PER_RUN} tags.` }, { status: 422 }),
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

// Removes tags from THIS run only. Tags aren't a shared entity — they're strings in
// the run's own `runTags` array — so there is nothing org-wide to delete, and other
// runs carrying the same tag are untouched.
async function removeRunTags(request: Request, params: ActionFunctionArgs["params"]) {
  const resolved = await resolveRequest(request, params);
  if (resolved.kind === "error") {
    return resolved.response;
  }
  const { environment: env, runId } = resolved;

  try {
    // A DELETE with no body at all is the natural thing to try by hand, and
    // `request.json()` throws on it. That's a malformed request, not a server fault, so
    // map it to 400 instead of letting it fall through to the catch-all 500 + error log.
    let anyBody: unknown;
    try {
      anyBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = RemoveTagsRequestBody.safeParse(anyBody);
    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }
    const bodyTags = typeof body.data.tags === "string" ? [body.data.tags] : body.data.tags;
    const nonEmptyTags = bodyTags.filter((t) => t.trim().length > 0);

    // Nothing asked for. No MAX_TAGS_PER_RUN check applies to a removal — it can
    // only ever shrink the list.
    if (nonEmptyTags.length === 0) {
      return json({ message: "No tags to remove" }, { status: 200 });
    }

    const outcome = await mutateWithFallback<Response>({
      runId,
      environmentId: env.id,
      organizationId: env.organizationId,
      bufferPatch: { type: "remove_tags", tags: nonEmptyTags },
      pgMutation: async (taskRun) => {
        const doomed = new Set(nonEmptyTags);
        let existing = taskRun.runTags ?? [];
        let remaining = existing.filter((t) => !doomed.has(t));

        if (existing.length === remaining.length) {
          // `taskRun` normally comes from the READ REPLICA, so "the run has none of
          // these tags" can just be replication lag rather than the truth — and
          // `tags.add("x")` immediately followed by `tags.delete("x")` is a completely
          // ordinary pattern. Confirm against the primary before concluding there's
          // nothing to do, the same disambiguation mutateWithFallback does for a
          // replica-lag 404. Passing the writer as the read client makes the routing
          // store read the OWNING store's primary, so this is read-your-writes for a
          // run on either database.
          //
          // The add path performs the mirror-image confirmation, for the same reason:
          // once removals exist a stale replica can equally make an add dedup away a
          // tag that is no longer on the run. Either direction would silently drop the
          // customer's mutation and still answer 200.
          const fresh = await runStore.findRun(
            { id: taskRun.id, runtimeEnvironmentId: env.id },
            { select: { runTags: true } },
            prisma
          );

          if (!fresh) {
            return json({ error: "Run not found" }, { status: 404 });
          }

          existing = fresh.runTags ?? [];
          remaining = existing.filter((t) => !doomed.has(t));
        }

        const removedCount = existing.length - remaining.length;

        // Removing tags the run doesn't have is an idempotent success, not a 404.
        // Skip the write entirely so we don't bump `updatedAt`, replicate a row that
        // didn't change, or publish a no-op realtime record.
        if (removedCount === 0) {
          return json({ message: "Successfully removed 0 tags." }, { status: 200 });
        }

        const updated = await runStore.removeTags(
          taskRun.id,
          nonEmptyTags,
          { runtimeEnvironmentId: env.id },
          prisma
        );

        // The run vanished (or moved environment) between the read and this write.
        if (!updated) {
          return json({ error: "Run not found" }, { status: 404 });
        }

        // Publish a run-changed record with the REMAINING tag set so tag feeds
        // reindex (no-op unless enabled). updatedAt is the read-your-writes
        // watermark. Note this record no longer carries the removed tag, so a feed
        // subscribed to that tag simply stops receiving this run — there is no
        // "tag removed" un-subscribe signal.
        publishChangeRecord({
          runId: taskRun.id,
          envId: env.id,
          tags: remaining,
          batchId: taskRun.batchId,
          updatedAtMs: updated.updatedAt.getTime(),
        });

        return json({ message: `Successfully removed ${removedCount} tags.` }, { status: 200 });
      },
      // Buffer-applied patch path. The Lua removed the tags from the snapshot
      // atomically. Count off the pre-mutation entry (already fetched by
      // mutateWithFallback's env-auth pre-check, so no extra Redis read) so the
      // message reports the same number the PG path would for the same input.
      synthesisedResponse: ({ bufferEntry }) => {
        // `null` here means the snapshot carried no readable `tags` array. For a
        // buffered run that is simply the shape of a run triggered without tags, so
        // there was nothing to remove — unlike the add path, whose unknown-existing
        // fallback is the request count, falling back to the request count here would
        // report removals that never happened on the most common buffered shape.
        const existing = parseSnapshotTags(bufferEntry) ?? [];
        const removedCount = existing.filter((t) => nonEmptyTags.includes(t)).length;
        return json({ message: `Successfully removed ${removedCount} tags.` }, { status: 200 });
      },
      // No `rejectedResponse`: a `remove_tags` patch carries no cap, so the buffer
      // never reports `limit_exceeded` for it.
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
    logger.error("Failed to remove run tags", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }
}
