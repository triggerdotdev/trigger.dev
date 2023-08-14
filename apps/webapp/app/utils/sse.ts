import { eventStream } from "remix-utils";
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
  let pinger: NodeJS.Timer | undefined = undefined;
  let updater: NodeJS.Timer | undefined = undefined;

  const abort = () => {
    if (pinger) {
      clearInterval(pinger);
    }

    if (updater) {
      clearInterval(updater);
    }
  };

  return eventStream(request.signal, (send) => {
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
          logger.debug("Uknown error sending SSE, aborting", {
            error,
            args,
          });
        }

        abort();
      }
    };

    pinger = setInterval(() => {
      safeSend({ event: "ping", data: new Date().toISOString() });
    }, pingInterval);

    updater = setInterval(async () => {
      run(safeSend, abort);
    }, updateInterval);

    return abort;
  });
}
