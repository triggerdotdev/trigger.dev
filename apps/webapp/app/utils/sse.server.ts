import { eventStream } from "remix-utils/sse/server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

type SseProps = {
  request: Request;
  pingInterval?: number;
  updateInterval?: number;
  run: (send: (event: Event) => void, stop: () => void) => void;
};

type Event = {
  /**
   * @default "update"
   */
  event?: string;
  data: string;
};

export function sse({ request, pingInterval = 1000, updateInterval = 348, run }: SseProps) {
  if (env.DISABLE_SSE === "1" || env.DISABLE_SSE === "true") {
    return new Response("SSE disabled", { status: 200 });
  }

  return eventStream(request.signal, (send, close) => {
    const safeSend = (args: { event?: string; data: string }) => {
      try {
        send(args);
      } catch (error) {
        if (error instanceof Error) {
          if (error.name !== "TypeError") {
            logger.debug("Error sending SSE, aborting", {
              error: {
                name: error.name,
                message: error.message,
                stack: error.stack,
              },
              args,
            });
          }
        } else {
          logger.debug("Unknown error sending SSE, aborting", {
            error,
            args,
          });
        }

        close();
      }
    };

    const pinger = setInterval(() => {
      if (request.signal.aborted) {
        return close();
      }

      safeSend({ event: "ping", data: new Date().toISOString() });
    }, pingInterval);

    const updater = setInterval(() => {
      if (request.signal.aborted) {
        return close();
      }

      run(safeSend, close);
    }, updateInterval);

    const timeout = setTimeout(() => {
      close();
    }, 60 * 1000); // 1 minute

    return () => {
      clearInterval(updater);
      clearInterval(pinger);
      clearTimeout(timeout);
    };
  });
}
