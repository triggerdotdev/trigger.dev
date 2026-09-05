import { json } from "@remix-run/server-runtime";
import { pageTranscriptEntries, parseTranscriptSnapshot } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { chatSnapshotStorageKey } from "~/services/realtime/chatSnapshot.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { downloadPacketFromObjectStore } from "~/v3/objectStore.server";

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

    let body: unknown;
    try {
      const packet = await downloadPacketFromObjectStore(
        { dataType: "application/store", data: chatSnapshotStorageKey(session) },
        authentication.environment
      );
      body = typeof packet.data === "string" ? JSON.parse(packet.data) : undefined;
    } catch {
      body = undefined;
    }

    const snapshot = parseTranscriptSnapshot(body);
    if (!snapshot) {
      return json({ messages: [], state: null });
    }

    const page = pageTranscriptEntries(snapshot.messages, searchParams);
    return json({
      messages: page.entries.map((entry) => entry.message),
      state: snapshot.state,
      cursors: {
        lastOutEventId: snapshot.lastOutEventId,
        lastInEventId: snapshot.lastInEventId,
      },
      nextCursor: page.nextCursor,
    });
  }
);
