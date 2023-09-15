import { TriggerClient,  } from "@trigger.dev/sdk";
import { Request as StandardRequest, Headers as StandardHeaders } from "@remix-run/web-fetch";
import { FastifyPluginCallback, FastifyRequest } from "fastify";
import fp from 'fastify-plugin';


export interface PluginOptions {
  tiggerDevClient: TriggerClient;
}

const pluginHandler: FastifyPluginCallback<PluginOptions> = (fastify, options, done) => {
  const prefix = '/api/trigger';
  console.info(`TriggerDevPlugin installing routes at prefix: ${prefix}`);

  const convertToStandardRequest = (req: FastifyRequest) => {
    const { headers: nextHeaders, method } = req;
  
    const headers = new StandardHeaders();
  
    Object.entries(nextHeaders).forEach(([key, value]) => {
      headers.set(key, value as string);
    });
  
    // Create a new Request object (hardcode the url because it doesn't really matter what it is)
    return new StandardRequest("https://fastify.js/api/trigger", {
      headers,
      method,
      // @ts-ignore
      body: req.body ? JSON.stringify(req.body) : req,
    });
  }
  
  fastify.post(`${prefix}`, async (req, reply) => {

    try {
      const request = convertToStandardRequest(req);
      const response = await options.tiggerDevClient.handleRequest(request);
      
      if (!response) {
        reply.status(404).send({ error: "Not found" });
      }

      reply.status(response.status).send(response.body);
    } catch (error) {
      reply.status(500).send({ message: `Trigger Dev SDK error occurred: ${error}` });
    }
  })

  done();
};

/**
 * Trigger Dev Fastify Plugin
 */
export default fp(pluginHandler);