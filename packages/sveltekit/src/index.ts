import type { TriggerClient } from "@trigger.dev/sdk";

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";

export function createSvelteRoute(client: TriggerClient) {
  const POST: RequestHandler = async ({ request }) => {
    const standardizedRequest = await convertToStandardRequest(request);
    const response = await client.handleRequest(standardizedRequest);

    if (!response) {
      return json({ error: "Resource not found" }, { status: 404 });
    }

    return json(response.body, { status: response.status, headers: response.headers });
  };
  return { POST };
}

async function convertToStandardRequest(req: Request): Promise<Request> {
  // Prepare the request to be a fetch-compatible Request object:
  const requestHeaders = req.headers;
  const requestMethod = req.method;
  const responseHeaders = Object.create(null);

  for (const [headerName, headerValue] of requestHeaders.entries()) {
    responseHeaders[headerName] = headerValue;
  }

  // Create a new Request object to be passed to the TriggerClient
  // where we pass the clone the incoming request metadata such as
  // headers, method, body.
  const request = new Request("https://svelte/api/trigger", {
    headers: responseHeaders,
    method: requestMethod,
    // @ts-ignore
    body: req.body ? req.body : req,
    duplex: "half",
  });

  return request;
}
