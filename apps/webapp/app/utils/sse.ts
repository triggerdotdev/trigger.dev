import { type LoaderFunctionArgs } from "@remix-run/node";
import { type Params } from "@remix-run/router";
import { eventStream } from "remix-utils/sse/server";
import { setInterval } from "timers/promises";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";

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
        } catch (error) {
          if (error instanceof Error) {
            if (error.message?.includes("Controller is already closed")) {
              return;
            }
            log(`Error sending event: ${error.message}`);
          }
          throw error;
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

    const requestAbortSignal = getRequestAbortSignal();

    log("Start");

    // Single-signal abort chain: everything rolls up into internalController with NO
    // string reasons (string reasons create a DOMException whose stack trace pins the
    // closure graph). Timeout is a plain setTimeout cleared on abort rather than an
    // AbortSignal.timeout() combined via AbortSignal.any(); both of those patterns
    // leak on Node 20 due to FinalizationRegistry tracking of dependent signals.
    const timeoutTimer = setTimeout(() => {
      if (!internalController.signal.aborted) internalController.abort();
    }, timeout);

    const onRequestAbort = () => {
      log("request signal aborted");
      if (!internalController.signal.aborted) internalController.abort();
    };
    requestAbortSignal.addEventListener("abort", onRequestAbort, { once: true });

    internalController.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutTimer);
        requestAbortSignal.removeEventListener("abort", onRequestAbort);
      },
      { once: true }
    );

    if (handlers.beforeStream) {
      const shouldContinue = await handlers.beforeStream();
      if (shouldContinue === false) {
        log("beforeStream returned false, so we'll exit before creating the stream");
        internalController.abort();
        return;
      }
    }

    return eventStream(internalController.signal, function setup(send) {
      connections.add(id);
      const safeSend = createSafeSend(send);

      async function run() {
        try {
          log("Initializing");
          if (handlers.initStream) {
            const shouldContinue = await handlers.initStream({ send: safeSend });
            if (shouldContinue === false) {
              log("initStream returned false, so we'll stop the stream");
              internalController.abort();
              return;
            }
          }

          log("Starting interval");
          for await (const _ of setInterval(interval, null, {
            signal: internalController.signal,
          })) {
            log("PING");

            const date = new Date();

            if (handlers.iterator) {
              try {
                const shouldContinue = await handlers.iterator({ date, send: safeSend });
                if (shouldContinue === false) {
                  log("iterator return false, so we'll stop the stream");
                  internalController.abort();
                  break;
                }
              } catch (error) {
                log("iterator threw an error, aborting stream");
                // Immediately abort to trigger cleanup
                if (error instanceof Error && error.name !== "AbortError") {
                  log(`iterator error: ${error.message}`);
                }
                internalController.abort();
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
