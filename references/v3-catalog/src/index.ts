import { SpanStatusCode } from "@opentelemetry/api";
import { flushOtel, getTracer } from "./tracer";

const tracer = getTracer("v3-catalog", "0.0.1");

import { parentTask } from "./trigger/simple";

export async function main() {
  const result = await tracer.startActiveSpan("main", async (span) => {
    try {
      const handle = await parentTask.trigger({
        payload: { message: "This is a message from the trigger-dev CLI" },
      });

      return handle;
    } catch (e) {
      if (e instanceof Error) {
        span.recordException(e);
      }

      span.setStatus({
        code: SpanStatusCode.ERROR,
      });
    } finally {
      span.end();
    }
  });

  await flushOtel();
}

main().then(console.log).catch(console.error);
