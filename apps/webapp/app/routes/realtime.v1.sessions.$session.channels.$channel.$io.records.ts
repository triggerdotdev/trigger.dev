import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  SESSION_CHANNEL_NAME_REGEX,
  sessionChannelResources,
} from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  isSessionFriendlyIdForm,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
  channel: z.string().regex(SESSION_CHANNEL_NAME_REGEX),
  io: z.enum(["out", "in"]),
});

const SearchSchema = z.object({
  afterEventId: z.string().regex(/^\d+$/).optional(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      const row = await resolveSessionWithWriterFallback(auth.environment.id, params.session);
      if (!row && isSessionFriendlyIdForm(params.session)) {
        return undefined;
      }
      return {
        row,
        addressingKey: canonicalSessionAddressingKey(row, params.session),
      };
    },
    authorization: {
      action: "read",
      resource: ({ row, addressingKey }, params) => {
        const ids = new Set<string>([addressingKey]);
        if (row) {
          ids.add(row.friendlyId);
          if (row.externalId) ids.add(row.externalId);
        }
        return anyResource(sessionChannelResources(params.channel, ids));
      },
    },
  },
  async ({ params, authentication, resource, searchParams }) => {
    const realtimeStream = getRealtimeStreamInstance(authentication.environment, "v2", {
      session: resource.row,
      organization: resource.row ? null : authentication.environment.organization,
    });

    if (!(realtimeStream instanceof S2RealtimeStreams)) {
      return new Response("Session channels require the S2 realtime backend", { status: 501 });
    }

    const afterSeqNum =
      searchParams.afterEventId !== undefined ? Number(searchParams.afterEventId) : undefined;

    const records = await realtimeStream.readSessionStreamRecords(
      resource.addressingKey,
      params.io,
      afterSeqNum,
      params.channel
    );

    return json({ records });
  }
);
