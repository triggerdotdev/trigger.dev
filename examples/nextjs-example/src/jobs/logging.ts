import { client } from "@/trigger";
import { Job, eventTrigger } from "@trigger.dev/sdk";

new Job(client, {
  id: "test-logging",
  name: "Test logging",
  version: "0.0.1",
  logLevel: "debug",
  trigger: eventTrigger({
    name: "test.logging",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.log("Hello log level", { payload });
    await io.logger.error("Hello error level", { payload });
    await io.logger.warn("Hello warn level", { payload });
    await io.logger.info("Hello info level", { payload });
    await io.logger.debug("Hello debug level", { payload });
  },
});
