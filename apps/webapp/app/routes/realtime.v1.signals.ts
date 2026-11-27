import { json } from "@remix-run/server-runtime";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import {
  SIGNALS_STREAM,
  SignalError,
  signalResumeSeq,
  signalStreamsFor,
  trackSignalSubscription,
} from "~/services/realtime/environmentSignals.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// A run's subscription to its environment's signals (SSE, S2's own stream passed through). A fresh
// subscription starts at the last record, which holds the latest signal of every name; with
// Last-Event-ID it resumes after that record (unless the id isn't one the stream has). The run filters by name and task itself: every
// listening run of the environment receives every record, which is what the environment's secret
// key could read anyway. Secret key, the run's own token, or a key with `read:signals`. Unstable.
export const loader = createLoaderApiRoute(
  {
    // The resource is the environment itself, which authentication already resolved.
    findResource: async () => true,
    authorization: { action: "read", resource: () => ({ type: "signals" }) },
  },
  async ({ request, authentication }) => {
    if (authentication.type !== "PRIVATE") {
      return new Response("Reading signals requires secret key authentication", { status: 403 });
    }

    let streams;
    try {
      streams = signalStreamsFor(authentication.environment);
    } catch (error) {
      if (error instanceof SignalError) {
        return json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const timeoutRaw = request.headers.get("Timeout-Seconds");
    const timeout = timeoutRaw ? Number(timeoutRaw) : undefined;
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)) {
      return new Response("Timeout seconds must be an integer from 1 to 600", { status: 400 });
    }

    const lastSeq = await signalResumeSeq(
      streams,
      request.headers.get("Last-Event-ID") ?? undefined
    );
    const environment = authentication.environment;
    const abortSignal = getRequestAbortSignal();
    const response = await startActiveSpan("signals.subscribe", async (span) => {
      span.setAttribute("environmentId", environment.id);
      if (lastSeq !== undefined) span.setAttribute("signal.resumeAfterSeq", lastSeq);
      return streams.streamResponseFromEnvironmentStream(SIGNALS_STREAM, abortSignal, {
        timeoutInSeconds: timeout,
        ...(lastSeq !== undefined
          ? // The stream reads from the record after this id.
            { lastEventId: String(lastSeq) }
          : { startFrom: "latest" as const }),
      });
    });
    if (!response.ok || !response.body) return response;

    // Counted while the response is open: it ends when S2's long poll ends or the run goes away.
    const done = trackSignalSubscription(environment, {
      resumeAfterSeq: lastSeq,
    });
    abortSignal.addEventListener("abort", done, { once: true });
    return new Response(response.body.pipeThrough(new TransformStream({ flush: done })), response);
  }
);
