import { Injectable, mixin, NestMiddleware, HttpStatus,  Type } from '@nestjs/common';
import { TriggerClient } from "@trigger.dev/sdk";
import { FastifyRequest, FastifyReply } from 'fastify';
import { Request as StandardRequest } from "@remix-run/web-fetch";

/**
 * This is a functional middleware for Nest.js to use with an existing nest.js application which is using fastify platform.
 * @param client - The TriggerClient to use for the middleware
 * @example
 * ```ts
 * // In app.module.ts 
 * export class AppModule {
 *      constructor(private readonly triggerClient: TriggerClient) {
 *          this.triggerClient = new TriggerClient({
 *             id: "my-client",
 *             apiKey: process.env["TRIGGER_API_KEY"],
 *          })
 *      }
 *      
 *      configure(consumer: MiddlewareConsumer) {
 *          consumer
 *              .apply(TriggerDevMiddlewareCreatorForFastify(this.triggerClient))
 *              .forRoutes('/api/trigger');
 *      }
 * }
 * ```
 */
export function TriggerDevMiddlewareCreatorForFastify(client: TriggerClient): Type<NestMiddleware> {

    @Injectable()
    class TriggerDevMiddleware implements NestMiddleware {
        constructor(){}
        
        async use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: (error?: any) => void) {
            try {
                const standardRequest = this.convertToStandardRequest(req);
                const triggerClientResponse = await client.handleRequest(standardRequest);

                if (!triggerClientResponse) {
                    
                    res.writeHead(HttpStatus.NOT_FOUND, { "content-type": "application/json"})
                    res.write({ error: "Not found" });
                    res.end();
                    return;
                }

                res.writeHead(triggerClientResponse.status, { "content-type": "application/json"});
                res.write(triggerClientResponse.body);
                res.end();
            } catch (error) {
                next(error);
            }

        }
        private convertToStandardRequest(req: FastifyRequest['raw']): StandardRequest {
            const { headers: nextHeaders, method } = req;

            const headers : Record<string, string> = {} 
            Object.entries(nextHeaders).forEach(([key, value]) => {
                headers[key] = value as string;
            });
            
            // Create a new Request object (hardcode the url because it doesn't really matter what it is)
            return new StandardRequest("https://fastify.js/api/trigger", {
            headers,
            method,
            // @ts-ignore
            body: req.body ? JSON.stringify(req.body) : req,
            });
        }
    }

    return mixin(TriggerDevMiddleware);
}
