import type { TriggerClient } from "@trigger.dev/sdk";
import type { NextApiRequest, NextApiResponse } from "next";

export function createPagesRoute(client: TriggerClient) {
  const handler = async function handler(req: NextApiRequest, res: NextApiResponse) {
    const normalizedRequest = await convertToStandardRequest(req);

    const response = await client.handleRequest(normalizedRequest);

    if (!response) {
      res.status(404).json({ error: "Not found" });

      return;
    }

    if (response.headers) {
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === "string") {
          res.setHeader(key, value);
        }
      }
    }

    res.status(response.status).json(response.body);
  };

  return {
    handler,
    config: {
      api: {
        bodyParser: false,
      },
    },
  };
}

export function createAppRoute(client: TriggerClient) {
  const POST = async function handler(req: Request) {
    const response = await client.handleRequest(req);

    if (!response) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };

  return {
    POST,
    dynamic: "force-dynamic",
    runtime: "nodejs",
    preferredRegion: "auto",
  } as const;
}

async function convertToStandardRequest(nextReq: NextApiRequest): Promise<Request> {
  const { headers: nextHeaders, method } = nextReq;

  const headers = new Headers();

  Object.entries(nextHeaders).forEach(([key, value]) => {
    headers.set(key, value as string);
  });

  // Create a new Request object (hardcode the url because it doesn't really matter what it is)
  const webReq = new Request("https://next.js/api/trigger", {
    headers,
    method,
    // @ts-ignore
    body: nextReq,
    duplex: "half",
  });

  return webReq;
}
