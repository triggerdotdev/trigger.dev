import { TriggerClient } from '@trigger.dev/sdk';
import { eventTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
    id: "nestjs-example",
    apiKey: process.env['TRIGGER_API_KEY'],
    apiUrl: process.env['TRIGGER_API_URL'],
    logLevel: 'debug',
    ioLogLocalEnabled: true,
    verbose: true,
});

client.defineJob({
    id: "hello-nestjs",
    name: "Hello Nestjs",
    version: "2.1.0",
    trigger: eventTrigger({
      name: "starter.hello-nes",
    }),
    run: async (_payload, io, _ctx) => {
      await io.wait("wait", 15);
      await io.logger.info("Hello Nestjs !");
      return {
        message: "Hello Nestjs!",
      };
    },
});