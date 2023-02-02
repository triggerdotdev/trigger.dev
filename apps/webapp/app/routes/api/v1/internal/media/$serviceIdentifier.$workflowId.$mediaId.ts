import type { LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { getApiConnectionsForWorkflow } from "~/models/apiConnection.server";
import { getAccessInfo } from "~/services/accessInfo.server";

const paramsSchema = z.object({
  serviceIdentifier: z.string(),
  workflowId: z.string(),
  mediaId: z.string(),
});

export async function loader({ request, params }: LoaderArgs) {
  const { serviceIdentifier, workflowId, mediaId } = paramsSchema.parse(params);

  const connections = await getApiConnectionsForWorkflow({ workflowId });
  const relevantConnection = connections.find(
    (c) => c.apiIdentifier === serviceIdentifier
  );
  if (!relevantConnection) {
    return {
      status: 404,
      body: `Could not find connection with serviceIdentifier ${serviceIdentifier}`,
    };
  }

  if (relevantConnection.status !== "CONNECTED") {
    return {
      status: 500,
      body: `Connection with serviceIdentifier ${serviceIdentifier} is not connected`,
    };
  }

  const accessInfo = await getAccessInfo(relevantConnection);

  switch (serviceIdentifier) {
    case "whatsapp": {
      if (accessInfo?.type !== "api_key") {
        return { status: 500, body: "Invalid access info" };
      }

      const accessToken = accessInfo.api_key;
      const mediaUrlResponse = await fetch(
        `https://graph.facebook.com/v15.0/${mediaId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!mediaUrlResponse.ok) {
        return {
          status: mediaUrlResponse.status,
          body: await mediaUrlResponse.text(),
        };
      }

      const json = await mediaUrlResponse.json();

      if (!json.url) {
        return {
          status: 500,
          body: `Could not find url in response: ${JSON.stringify(json)}`,
        };
      }

      const media = await fetch(json.url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!media.ok) {
        return {
          status: media.status,
          body: await media.text(),
        };
      }

      return new Response(media.body, {
        headers: {
          "Content-Type": json.mime_type,
          "Content-Disposition": `attachment;`,
        },
      });
    }
  }

  return {
    status: 500,
    body: `Unknown serviceIdentifier ${serviceIdentifier}`,
  };
}
