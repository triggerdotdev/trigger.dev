import { createRedwoodRoute } from "@trigger.dev/redwood";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

export const handler = async (event: any, _: any) => {
    const client = new TriggerClient({
        id: "redwood-test",
        apiUrl: process.env.TRIGGER_API_URL,
        apiKey: process.env.TRIGGER_API_KEY,
    });
    client.defineJob({
        version: "0.0.1",
        id: "redwood-test",
        name: "redwood test Job",
        trigger: eventTrigger({
            name: "test.event",
        }),
        run: async (payload, io, ctx) => {
            await io.wait("hold on", 5);
            await io.logger.info("Hello world!", { payload });
            return {
                message: "Hello world!",
            };
        },
    });
    return await createRedwoodRoute(event.request, client);
};