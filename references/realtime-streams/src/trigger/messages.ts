import { task, logger, metadata, wait } from "@trigger.dev/sdk";
import { messageInputStream } from "../app/streams";

export const messagesTask = task({
  id: "messages-flow",
  run: async (payload: { messageCount?: number }) => {
    const expected = payload.messageCount ?? 5;
    const received: { text: string }[] = [];

    metadata.set("status", "listening");
    metadata.set("received", 0);
    metadata.set("expected", expected);

    logger.info("Subscribing to messages via .on()", { expected });

    const { off } = messageInputStream.on((data) => {
      logger.info("Received message", { data });
      received.push(data);
      metadata.set("received", received.length);
    });

    while (received.length < expected) {
      await wait.for({ seconds: 1 });
    }

    off();

    metadata.set("status", "done");
    logger.info("Done receiving messages", { count: received.length });

    return { messages: received };
  },
});
