import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  getApiConnectionsForOrganizationId,
  createAPIConnection,
  setConnectedAPIConnection,
} from "~/models/apiConnection.server";
import { integrations } from "~/components/integrations/ConnectButton";
import { requireUserId } from "~/services/session.server";
import { APIConnectionType } from ".prisma/client";
import { env } from "~/env.server";

const requestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    organizationId: z.string(),
    key: z.string(),
  }),
  z.object({
    type: z.literal("update"),
    connectionId: z.string(),
  }),
]);

export type CreateResponse = {
  host: string;
  integrationKey: string;
  connectionId: string;
};

export type UpdateResponse = {
  success: boolean;
};

export const action = async ({ request, params }: ActionArgs) => {
  const userId = await requireUserId(request);
  if (userId === null) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const body = Object.fromEntries(formData.entries());
    const parsed = requestSchema.parse(body);

    switch (parsed.type) {
      case "create": {
        const { organizationId, key } = parsed;

        const integrationInfo = integrations.find((i) => i.key === key);
        if (!integrationInfo) {
          throw new Error("Integration not found");
        }

        //get a unique name for the connection (e.g. GitHub #4)
        const organizationConnections =
          await getApiConnectionsForOrganizationId({ id: organizationId });
        const connectionsForApiIdentifier = organizationConnections
          .filter((connection) => connection.apiIdentifier === key)
          .sort((a, b) => a.title.localeCompare(b.title));
        let title = integrationInfo.name;
        if (connectionsForApiIdentifier.length > 0) {
          title += ` #${connectionsForApiIdentifier.length + 1}`;
        }

        const connection = await createAPIConnection({
          organizationId,
          title,
          apiIdentifier: key,
          scopes: [],
          type: APIConnectionType.HTTP,
        });

        const response: CreateResponse = {
          host: env.PIZZLY_HOST,
          integrationKey: key,
          connectionId: connection.id,
        };

        return json(response);
      }
      case "update": {
        const { connectionId } = parsed;
        await setConnectedAPIConnection({
          id: connectionId,
        });

        return json({
          success: true,
        });
      }
    }
  } catch (error: any) {
    return json({ message: error.message }, { status: 400 });
  }
};
