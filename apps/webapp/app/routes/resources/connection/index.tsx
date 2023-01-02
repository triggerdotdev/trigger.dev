import { APIConnectionType } from ".prisma/client";
import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import {
  createAPIConnection,
  getApiConnectionsForOrganizationId,
} from "~/models/apiConnection.server";
import { getIntegrations } from "~/models/integrations.server";
import { requireUserId } from "~/services/session.server";

const baseSchema = z.object({
  organizationId: z.string(),
  service: z.string(),
});

const requestSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("oauth"),
    }),
    z.object({
      type: z.literal("api_key"),
      api_key: z.string(),
      title: z.string(),
    }),
  ])
  .and(baseSchema);

export type Request = z.infer<typeof requestSchema>;
export type Response = {
  pizzlyHost?: string;
  service: string;
  connectionId: string;
};

export const action = async ({ request }: ActionArgs) => {
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

    const integrationInfo = getIntegrations().find(
      (i) => i.slug === parsed.service
    );
    if (!integrationInfo) {
      throw new Error("Integration not found");
    }

    switch (parsed.type) {
      case "oauth": {
        //get a unique name for the connection (e.g. GitHub #4)
        const organizationConnections =
          await getApiConnectionsForOrganizationId({
            id: parsed.organizationId,
          });
        const connectionsForApiIdentifier = organizationConnections
          .filter((connection) => connection.apiIdentifier === parsed.service)
          .sort((a, b) => a.title.localeCompare(b.title));

        let title = integrationInfo.name;
        if (connectionsForApiIdentifier.length > 0) {
          title += ` #${connectionsForApiIdentifier.length + 1}`;
        }

        const connection = await createAPIConnection({
          organizationId: parsed.organizationId,
          title,
          apiIdentifier: parsed.service,
          scopes: [],
          authenticationMethod: "OAUTH",
          authenticationConfig: null,
          type: APIConnectionType.HTTP,
        });

        const response: Response = {
          pizzlyHost: env.PIZZLY_HOST,
          service: parsed.service,
          connectionId: connection.id,
        };

        return json(response);
      }
      case "api_key": {
        const connection = await createAPIConnection({
          organizationId: parsed.organizationId,
          title: parsed.title,
          apiIdentifier: parsed.service,
          scopes: [],
          authenticationMethod: "API_KEY",
          authenticationConfig: {
            api_key: parsed.api_key,
          },
          type: APIConnectionType.HTTP,
        });

        const response: Response = {
          service: parsed.service,
          connectionId: connection.id,
        };

        return json(response);
      }
    }
  } catch (error: any) {
    console.log("error", error);
    return json({ message: error.message }, { status: 400 });
  }
};
