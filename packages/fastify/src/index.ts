import fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { TriggerClient } from "@trigger.dev/sdk";
import { Request as StandardRequest, Headers as StandardHeaders } from "@remix-run/web-fetch";

/**
 * This is a convenience function to create a Fastify server for the TriggerClient. If you want to use Trigger.dev with an existing Fastify server, use `createMiddleware` instead.
 * @param client - The TriggerClient to use for the server.
 * @param port - The port to listen on, defaults to 8080.
 */
export function createFastifyServer(
  client: TriggerClient,
  port: number = 3000,
  path: string = "/api/trigger"
): FastifyInstance {
  const app = fastify();

  const middleware = createMiddleware(client, path);

  app.addHook("preHandler", middleware);

  app.listen({ port }, () => {
    console.log(`Endpoint ${client.id} listening on port ${port}`);
  });

  return app;
}

export function createMiddleware(client: TriggerClient, path: string = "/api/trigger") {
  return async (req: FastifyRequest, res: FastifyReply) => {
    if (req.url !== path) {
      return;
    }

    if (req.method === "HEAD") {
      res.status(200).send();
      return;
    }

    try {
      const request = convertToStandardRequest(req);

      const response = await client.handleRequest(request);

      if (!response) {
        res.status(404).send({ error: "Not found" });
      } else {
        res.status(response.status).send(response.body);
      }
    } catch (error) {
      throw error;
    }
  };
}

function convertToStandardRequest(req: FastifyRequest): StandardRequest {
  const { headers: nextHeaders, method } = req;

  const headers: Record<string, string> = {};

  for (let [key, value] of Object.entries(nextHeaders)) {
    headers[key] = value as string;
  }

  // Create a new Request object (hardcode the url because it doesn't really matter what it is)
  return new StandardRequest("https://fastify.js/api/trigger", {
    headers: headers,
    method,
    // @ts-ignore
    body: req.body ? JSON.stringify(req.body) : req,
  });
}
