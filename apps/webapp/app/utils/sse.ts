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

// Stackless sentinel reasons passed to AbortController#abort. Calling .abort()
// with no argument produces a DOMException that captures a ~500-byte stack
// trace; a string reason is stored verbatim with no stack. The choice of
// reason type does not cause the retention we saw in prod (that was the
// AbortSignal.any composite — see comment near the timeoutTimer below for the
// Node issue refs), but naming the sentinels keeps call sites readable and
// lets future signal.reason consumers branch on the cause.
export const ABORT_REASON_REQUEST = "request_aborted";
export const ABORT_REASON_TIMEOUT = "timeout";
export const ABORT_REASON_SEND_ERROR = "send_error";
export const ABORT_REASON_INIT_STOP = "init_requested_stop";
export const ABORT_REASON_ITERATOR_STOP = "iterator_requested_stop";
export const ABORT_REASON_ITERATOR_ERROR = "iterator_error";

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
          // Abort before rethrowing so timer + request-abort listener are cleaned
          // up immediately. Otherwise a send-failure in initStream leaves them
          // alive until `timeout` fires.
          if (!internalController.signal.aborted) {
            internalController.abort(ABORT_REASON_SEND_ERROR);
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

    // Single-signal abort chain: everything rolls up into internalController.
    // Timeout is a plain setTimeout cleared on abort rather than an
    // AbortSignal.timeout() combined via AbortSignal.any() — AbortSignal.any
    // keeps its source signals in an internal Set<WeakRef> managed by a
    // FinalizationRegistry, and under sustained request traffic those entries
    // accumulate faster than they get cleaned up, pinning every source signal
    // (and its listeners, and anything those listeners close over) until the
    // parent signal is GC'd or aborts. Reproduced locally in isolation; shape
    // matches the ChainSafe Lodestar production case described in
    // nodejs/node#54614. See also nodejs/node#55351 (mechanism confirmed by
    // @jasnell, narrow fix in 22.12.0 via #55354) and nodejs/node#57584
    // (circular-dep variant, still open).
    const timeoutTimer = setTimeout(() => {
      if (!internalController.signal.aborted) internalController.abort(ABORT_REASON_TIMEOUT);
    }, timeout);

    const onRequestAbort = () => {
      log("request signal aborted");
      if (!internalController.signal.aborted) internalController.abort(ABORT_REASON_REQUEST);
    };

    internalController.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutTimer);
        requestAbortSignal.removeEventListener("abort", onRequestAbort);
      },
      { once: true }
    );

    // The request could have been aborted during `await handler(context)` above.
    // AbortSignal listeners added after the signal is already aborted never fire,
    // so invoke cleanup synchronously in that case instead of waiting for `timeout`.
    if (requestAbortSignal.aborted) {
      onRequestAbort();
    } else {
      requestAbortSignal.addEventListener("abort", onRequestAbort, { once: true });
    }

    if (handlers.beforeStream) {
      const shouldContinue = await handlers.beforeStream();
      if (shouldContinue === false) {
        log("beforeStream returned false, so we'll exit before creating the stream");
        internalController.abort(ABORT_REASON_INIT_STOP);
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
              internalController.abort(ABORT_REASON_INIT_STOP);
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
                  internalController.abort(ABORT_REASON_ITERATOR_STOP);
                  break;
                }
              } catch (error) {
                log("iterator threw an error, aborting stream");
                // Immediately abort to trigger cleanup
                if (error instanceof Error && error.name !== "AbortError") {
                  log(`iterator error: ${error.message}`);
                }
                internalController.abort(ABORT_REASON_ITERATOR_ERROR);
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
