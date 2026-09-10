import { json } from "@remix-run/server-runtime";
import { pageTranscriptEntries, parseTranscriptBlob } from "@trigger.dev/core/v3";
import { z } from "zod/v4";
import { $replica } from "~/db.server";
import { chatSnapshotStorageKey } from "~/services/realtime/chatSnapshot.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { readTranscriptPageRanged } from "~/services/realtime/transcriptPage.server";
import { downloadPacketFromObjectStore } from "~/v3/objectStore.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  sessionId: z.string(),
});

const SearchParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  before: z.string().optional(),
});

function sessionResource(
  paramId: string,
  session: { friendlyId: string; externalId: string | null } | null | undefined
) {
  const ids = new Set<string>([paramId]);
  if (session) {
    ids.add(session.friendlyId);
    if (session.externalId) ids.add(session.externalId);
  }
  return anyResource([...ids].map((id) => ({ type: "sessions" as const, id })));
}

function isObjectNotFound(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|nosuchkey|404|does not exist/i.test(message);
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchParamsSchema,
    corsStrategy: "none",
    findResource: async (params, auth) =>
      resolveSessionByIdOrExternalId($replica, auth.environment.id, params.sessionId),
    authorization: {
      action: "read",
      resource: (session, params) => sessionResource(params.sessionId, session),
    },
  },
  async ({ authentication, resource: session, searchParams }) => {
    if (!session) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    const storageKey = chatSnapshotStorageKey(session);
    const location = {
      projectRef: authentication.environment.project.externalRef,
      envSlug: authentication.environment.slug,
    };

    try {
      const paged = await readTranscriptPageRanged(storageKey, location, searchParams);
      if (paged !== "unsupported") {
        return json({
          messages: paged.messages,
          state: null,
          cursors: paged.cursors,
          nextCursor: paged.nextCursor,
        });
      }
    } catch (error) {
      if (!isObjectNotFound(error)) {
        logger.warn("transcript endpoint: ranged read failed, falling back to full read", {
          sessionId: session.friendlyId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let body: string | undefined;
    try {
      const packet = await downloadPacketFromObjectStore(
        { dataType: "application/store", data: storageKey },
        authentication.environment
      );
      body = typeof packet.data === "string" ? packet.data : undefined;
    } catch (error) {
      // A missing blob is a valid empty transcript (a session that has not
      // saved yet). Any other read failure must NOT look like an empty chat:
      // return an error so the client falls back to the whole-blob read
      // instead of rendering a saved conversation as empty.
      if (isObjectNotFound(error)) {
        return json({ messages: [], state: null });
      }
      logger.error("transcript endpoint: snapshot read failed", {
        sessionId: session.friendlyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "Failed to read transcript" }, { status: 502 });
    }

    const snapshot = body === undefined ? undefined : parseTranscriptBlob(body);
    if (!snapshot) {
      return json({ messages: [], state: null });
    }

    const cursors = {
      lastOutEventId: snapshot.lastOutEventId,
      lastInEventId: snapshot.lastInEventId,
    };

    const page = pageTranscriptEntries(snapshot.messages, searchParams);
    return json({
      messages: page.entries.map((entry) => entry.message),
      state: null,
      cursors,
      nextCursor: page.nextCursor,
    });
  }
);
