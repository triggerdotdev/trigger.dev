import { TriggerClient } from "@trigger.dev/sdk";
import { Request as StandardRequest, Headers as StandardHeaders } from "@remix-run/web-fetch";
import type { EventHandlerRequest, H3Event, NodeIncomingMessage } from "h3";

function getRequestBody(req: NodeIncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString(); 
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });

}

export const createNuxtRoute = (client: TriggerClient) => {
  return async (event: H3Event<EventHandlerRequest>) => {
    if (event.node.req.method === "HEAD") {
      event.node.res.statusCode = 200;
      return;
    }

    try {
      const request = await convertToStandardRequest(event.node.req);
      const response = await client.handleRequest(request);

      if (!response) {
        event.node.res.statusCode = 404;
        event.node.res.setHeader("Content-Type", "application/json");
        event.node.res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      event.node.res.statusCode = response.status;
      event.node.res.setHeader("Content-Type", "application/json");
      event.node.res.end(JSON.stringify(response.body));
    } catch (error) {
      event.node.res.statusCode = 500;
      event.node.res.setHeader("Content-Type", "application/json");
      event.node.res.end(JSON.stringify({ error: (error as Error).message }));
    }
  };

  async function convertToStandardRequest(req: NodeIncomingMessage): Promise<StandardRequest> {
    const { headers: nuxtHeaders, method } = req;

    const headers = new StandardHeaders();

    Object.entries(nuxtHeaders).forEach(([key, value]) => {
      headers.set(key, value as string);
    });
    const body = await getRequestBody(req)
    // Create a new Request object (hardcode the url because it doesn't really matter what it is)
    return new StandardRequest("https://nuxt.js/api/trigger", {
      headers,
      method,
      body: body,
      // @ts-ignore
    duplex: "half",
    });
  }
};
