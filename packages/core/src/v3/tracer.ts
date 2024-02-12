import {
  Context,
  SpanOptions,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { Logger, logs } from "@opentelemetry/api-logs";
import { SemanticInternalAttributes } from "./semanticInternalAttributes";

export type TriggerTracerConfig =
  | {
      name: string;
      version: string;
    }
  | {
      tracer: Tracer;
      logger: Logger;
    };

export class TriggerTracer {
  constructor(private readonly _config: TriggerTracerConfig) {}

  private _tracer: Tracer | undefined;
  private get tracer(): Tracer {
    if (!this._tracer) {
      if ("tracer" in this._config) return this._config.tracer;

      this._tracer = trace.getTracer(this._config.name, this._config.version);
    }

    return this._tracer;
  }

  private _logger: Logger | undefined;
  private get logger(): Logger {
    if (!this._logger) {
      if ("logger" in this._config) return this._config.logger;

      this._logger = logs.getLogger(this._config.name, this._config.version);
    }

    return this._logger;
  }

  extractContext(traceContext?: Record<string, unknown>) {
    return propagation.extract(context.active(), traceContext ?? {});
  }

  startActiveSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
    ctx?: Context
  ): Promise<T> {
    const parentContext = ctx ?? context.active();

    const attributes = options?.attributes ?? {};

    return this.tracer.startActiveSpan(
      name,
      {
        ...options,
        attributes,
      },
      parentContext,
      async (span) => {
        this.tracer
          .startSpan(
            name,
            {
              ...options,
              attributes: {
                ...attributes,
                [SemanticInternalAttributes.SPAN_PARTIAL]: true,
                [SemanticInternalAttributes.SPAN_ID]: span.spanContext().spanId,
              },
            },
            parentContext
          )
          .end();

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
