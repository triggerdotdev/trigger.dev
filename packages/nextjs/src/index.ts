import type { TriggerClient } from "@trigger.dev/sdk";
import type { NextApiRequest, NextApiResponse } from "next";
import { NextResponse } from "next/server";

export function createPagesRoute(client: TriggerClient) {
  const handler = async function handler(req: NextApiRequest, res: NextApiResponse) {
    const normalizedRequest = await convertToStandardRequest(req);

    const response = await client.handleRequest(normalizedRequest);

    if (!response) {
      res.status(404).json({ error: "Not found" });

      return;
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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(response.body, { status: response.status });
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
