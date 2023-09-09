import { Injectable, mixin, NestMiddleware, HttpStatus,  Type } from '@nestjs/common';
import { TriggerClient } from "@trigger.dev/sdk";
import { Response as ResponseExpress, Request } from 'express';
import { Request as StandardRequest } from "@remix-run/web-fetch";

/**
 * This is a functional middleware for Nest.js to use with an existing nest.js application which is using express platform.
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
 *              .apply(TriggerDevMiddlewareCreatorForExpress(this.triggerClient))
 *              .forRoutes('/api/trigger');
 *      }
 * }
 * ```
 */
export function TriggerDevMiddlewareCreatorForExpress(client: TriggerClient): Type<NestMiddleware> {

    @Injectable()
    class TriggerDevMiddleware implements NestMiddleware {
        constructor(){}
        
        async use(req: Request, res: ResponseExpress, next: (error?: any) => void) {
            try {
                const standardRequest = this.convertToStandardRequest(req);
                const triggerClientResponse = await client.handleRequest(standardRequest);

                if (!triggerClientResponse) {
                    
                    res.status(HttpStatus.NOT_FOUND).send({ error: "Not found" });
                    return;
                }
                
                res.status(triggerClientResponse.status).json(triggerClientResponse.body);

            } catch (error) {
                next(error);
            }

        }

        private convertToStandardRequest(req: Request): StandardRequest {
            const { headers: nextHeaders, method } = req;

            const headers : Record<string, string> = {} 
            Object.entries(nextHeaders).forEach(([key, value]) => {
                headers[key] = value as string;
            });
            
            // Create a new Request object (hardcode the url because it doesn't really matter what it is)
            return new StandardRequest("https://express.js/api/trigger", {
            headers,
            method,
            // @ts-ignore
            body: req.body ? JSON.stringify(req.body) : req,
            });
        }
    }

    return mixin(TriggerDevMiddleware);
}