import { accessoryAttributes, SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "./tracer.js";

/** The warm window uses compute; it must not be presented as a waitpoint. */
export function traceSessionIdle<T>(
  sessionId: string,
  idleTimeoutInSeconds: number,
  read: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan("idle", read, {
    attributes: {
      [SemanticInternalAttributes.STYLE_ICON]: "sessions",
      session: sessionId,
      io: "in",
      "wait.phase": "idle",
      "wait.idleTimeoutInSeconds": idleTimeoutInSeconds,
      ...accessoryAttributes({
        items: [{ text: `up to ${idleTimeoutInSeconds}s`, variant: "normal" }],
        style: "codepath",
      }),
    },
  });
}

/** Attach the waitpoint before starting the wait, including for partial spans. */
export function traceSessionWait<T extends { ok: boolean; error?: Error }>(
  sessionId: string,
  waitpointId: string,
  wait: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    "wait.forToken()",
    async (span) => {
      const result = await wait();
      if (!result.ok && result.error) {
        span.recordException(result.error);
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return result;
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "wait",
        [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
        [SemanticInternalAttributes.ENTITY_ID]: waitpointId,
        session: sessionId,
        io: "in",
        "wait.phase": "suspended",
      },
    }
  );
}
