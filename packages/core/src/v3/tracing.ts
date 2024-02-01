import {
  Context,
  SpanOptions,
  SpanStatusCode,
  context,
  propagation,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import { taskContextManager } from "./tasks/taskContextManager";

export class TriggerTracer {
  constructor(private readonly tracer: Tracer) {}

  extractContext(traceContext?: Record<string, unknown>) {
    return propagation.extract(context.active(), traceContext ?? {});
  }

  startActiveSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
    ctx?: Context
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      name,
      options ?? {},
      ctx ?? context.active(),
      async (span) => {
        span.setAttribute(SemanticAttributes.MESSAGING_SYSTEM, "trigger.dev");
        span.setAttribute(SemanticAttributes.MESSAGING_DESTINATION, "trigger.dev");
        span.setAttributes(taskContextManager.attributes);

        try {
          return await fn(span);
        } catch (e) {
          if (typeof e === "string" || e instanceof Error) {
            span.recordException(e);
          }

          span.setStatus({ code: SpanStatusCode.ERROR });

          throw e;
        } finally {
          span.end();
        }
      }
    );
  }
}
