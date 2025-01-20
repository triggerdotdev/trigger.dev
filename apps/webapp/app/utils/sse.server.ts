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

  let pinger: NodeJS.Timeout | undefined = undefined;
  let updater: NodeJS.Timeout | undefined = undefined;
  let timeout: NodeJS.Timeout | undefined = undefined;

  const abort = () => {
    clearInterval(pinger);
    clearInterval(updater);
    clearTimeout(timeout);
  };

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

    pinger = setInterval(() => {
      if (request.signal.aborted) {
        return abort();
      }

      safeSend({ event: "ping", data: new Date().toISOString() });
    }, pingInterval);

    updater = setInterval(() => {
      if (request.signal.aborted) {
        return abort();
      }

      run(safeSend, abort);
    }, updateInterval);

    timeout = setTimeout(() => {
      close(); // close the connection after 1 minute of inactivity, which will refresh the connection (that's why we aren't using abort)
    }, 60 * 1000); // 1 minute

    return abort;
  });
}
