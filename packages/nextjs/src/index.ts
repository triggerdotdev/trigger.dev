import type { TriggerClient } from "@trigger.dev/sdk";
import type { NextApiRequest, NextApiResponse } from "next";
import { NextResponse } from "next/server";

export type TriggerHandlerOptions = {
  path: string;
};

export function createPagesRoute(
  client: TriggerClient,
  options: TriggerHandlerOptions
) {
  client.path = options.path;

  const handler = async function handler(
    req: NextApiRequest,
    res: NextApiResponse
  ) {
    const normalizedRequest = await convertToStandardRequest(client.url, req);

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

export function createAppRoute(
  client: TriggerClient,
  options: TriggerHandlerOptions
) {
  client.path = options.path;

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
  };
}

async function convertToStandardRequest(
  url: string,
  nextReq: NextApiRequest
): Promise<Request> {
  const { headers: nextHeaders, method } = nextReq;

  const headers = new Headers();

  Object.entries(nextHeaders).forEach(([key, value]) => {
    headers.set(key, value as string);
  });

  // Create a new Request object
  const webReq = new Request(url, {
    headers,
    method,
    // @ts-ignore
    body: nextReq,
  });

  return webReq;
}
