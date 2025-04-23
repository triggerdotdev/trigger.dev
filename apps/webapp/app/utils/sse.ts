import { type LoaderFunctionArgs } from "@remix-run/node";
import { type Params } from "@remix-run/router";
import { eventStream } from "remix-utils/sse/server";
import { setInterval } from "timers/promises";

export type SendFunction = Parameters<Parameters<typeof eventStream>[1]>[0];

type HandlerParams = {
  send: SendFunction;
};

type SSEHandlers = {
  /** Return false to stop */
  beforeStream?: () => Promise<boolean | void> | boolean | void;
  /** Return false to stop */
  initStream?: (params: HandlerParams) => Promise<boolean | void> | boolean | void;
  /** Return false to stop */
  iterator?: (params: HandlerParams & { date: Date }) => Promise<boolean | void> | boolean | void;
  cleanup?: (params: HandlerParams) => void;
};

type SSEContext = {
  id: string;
  request: Request;
  params: Params<string>;
  controller: AbortController;
  debug: (message: string) => void;
};

type SSEOptions = {
  timeout: number;
  interval?: number;
  debug?: boolean;
  handler: (context: SSEContext) => Promise<SSEHandlers>;
};

// This is used to track the open connections, for debugging
const connections: Set<string> = new Set();

export function createSSELoader(options: SSEOptions) {
  const { timeout, interval = 500, debug = false, handler } = options;

  return async function loader({ request, params }: LoaderFunctionArgs) {
    const id = request.headers.get("x-request-id") || Math.random().toString(36).slice(2, 8);

    const internalController = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeout);

    const log = (message: string) => {
      if (debug)
        console.log(
          `SSE: [${request.url} ${id}] ${message} (${connections.size} open connections)`
        );
    };

    const createSafeSend = (originalSend: SendFunction): SendFunction => {
      return (event) => {
        try {
          if (!internalController.signal.aborted) {
            originalSend(event);
          }
          // If controller is aborted, silently ignore the send attempt
        } catch (error) {
          if (error instanceof Error) {
            if (error.message?.includes("Controller is already closed")) {
              // Silently handle controller closed errors
              return;
            }
            log(`Error sending event: ${error.message}`);
          }
          throw error; // Re-throw other errors
        }
      };
    };

    const context: SSEContext = {
      id,
      request,
      params,
      controller: internalController,
      debug: log,
    };

    const handlers = await handler(context).catch((error) => {
      if (error instanceof Response) {
        throw error;
      }

      throw new Response("Internal Server Error", { status: 500 });
    });

    const combinedSignal = AbortSignal.any([
      request.signal,
      timeoutSignal,
      internalController.signal,
    ]);

    log("Start");

    request.signal.addEventListener(
      "abort",
      () => {
        log(`request signal aborted`);
        internalController.abort("Request aborted");
      },
      { once: true, signal: internalController.signal }
    );

    combinedSignal.addEventListener(
      "abort",
      () => {
        log(`combinedSignal aborted: ${combinedSignal.reason}`);
      },
      { once: true, signal: internalController.signal }
    );

    timeoutSignal.addEventListener(
      "abort",
      () => {
        if (internalController.signal.aborted) return;
        log(`timeoutSignal aborted: ${timeoutSignal.reason}`);
        internalController.abort("Timeout");
      },
      { once: true, signal: internalController.signal }
    );

    if (handlers.beforeStream) {
      const shouldContinue = await handlers.beforeStream();
      if (shouldContinue === false) {
        log("beforeStream returned false, so we'll exit before creating the stream");
        internalController.abort("Init requested stop");
        return;
      }
    }

    return eventStream(combinedSignal, function setup(send) {
      connections.add(id);
      const safeSend = createSafeSend(send);

      async function run() {
        try {
          log("Initializing");
          if (handlers.initStream) {
            const shouldContinue = await handlers.initStream({ send: safeSend });
            if (shouldContinue === false) {
              log("initStream returned false, so we'll stop the stream");
              internalController.abort("Init requested stop");
              return;
            }
          }

          log("Starting interval");
          for await (const _ of setInterval(interval, null, {
            signal: combinedSignal,
          })) {
            log("PING");

            const date = new Date();

            if (handlers.iterator) {
              try {
                const shouldContinue = await handlers.iterator({ date, send: safeSend });
                if (shouldContinue === false) {
                  log("iterator return false, so we'll stop the stream");
                  internalController.abort("Iterator requested stop");
                  break;
                }
              } catch (error) {
                log("iterator threw an error, aborting stream");
                // Immediately abort to trigger cleanup
                internalController.abort(error instanceof Error ? error.message : "Iterator error");
                // No need to re-throw as we're handling it by aborting
                return; // Exit the run function immediately
              }
            }
          }
          log("iterator finished all iterations");
        } catch (error) {
          if (error instanceof Error) {
            if (error.name !== "AbortError") {
              console.error(error);
            }
          }
        } finally {
          log("iterator finished");
        }
      }

      run();

      return () => {
        connections.delete(id);

        log("Cleanup called");
        if (handlers.cleanup) {
          try {
            handlers.cleanup({ send: safeSend });
          } catch (error) {
            log(
              `Error in cleanup handler: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            );
            console.error("SSE Cleanup Error:", error);
          }
        }
      };
    });
  };
}
