import {
  Attributes,
  Context,
  SpanOptions,
  SpanStatusCode,
  TimeInput,
  context,
  propagation,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { Logger, logs } from "@opentelemetry/api-logs";
import { clock } from "./clock-api.js";
import { isCompleteTaskWithOutput } from "./errors.js";
import { recordSpanException } from "./otel/utils.js";
import { SemanticInternalAttributes } from "./semanticInternalAttributes.js";
import { taskContext } from "./task-context-api.js";
import { usage } from "./usage-api.js";

export type TriggerTracerConfig =
  | {
      name: string;
      version: string;
    }
  | {
      tracer: Tracer;
      logger: Logger;
    };

export type TriggerTracerSpanEvent = {
  name: string;
  attributes?: Attributes;
  startTime?: TimeInput;
};

export type TriggerTracerSpanOptions = SpanOptions & {
  events?: TriggerTracerSpanEvent[];
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
    options?: TriggerTracerSpanOptions,
    ctx?: Context,
    signal?: AbortSignal
  ): Promise<T> {
    const parentContext = ctx ?? context.active();

    const attributes = options?.attributes ?? {};

    let spanEnded = false;

    const createPartialSpanWithEvents = options?.events && options.events.length > 0;

    return this.tracer.startActiveSpan(
      name,
      {
        ...options,
        attributes: {
          ...attributes,
          ...(createPartialSpanWithEvents
            ? {
                [SemanticInternalAttributes.SKIP_SPAN_PARTIAL]: true,
              }
            : {}),
        },
        startTime: clock.preciseNow(),
      },
      parentContext,
      async (span) => {
        signal?.addEventListener("abort", () => {
          if (!spanEnded) {
            spanEnded = true;
            recordSpanException(span, signal.reason);
            span.end();
          }
        });

        if (taskContext.ctx && createPartialSpanWithEvents) {
          const partialSpan = this.tracer.startSpan(
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
          );

          if (options?.events) {
            for (const event of options.events) {
              partialSpan.addEvent(event.name, event.attributes, event.startTime);
            }
          }

          partialSpan.end();
        }

        if (options?.events) {
          for (const event of options.events) {
            span.addEvent(event.name, event.attributes, event.startTime);
          }
        }

        const usageMeasurement = usage.start();

        try {
          return await fn(span);
        } catch (e) {
          if (isCompleteTaskWithOutput(e)) {
            if (!spanEnded) {
              span.end(clock.preciseNow());
            }

            throw e;
          }

          if (!spanEnded) {
            if (typeof e === "string" || e instanceof Error) {
              span.recordException(e);
            }

            span.setStatus({ code: SpanStatusCode.ERROR });
          }

          throw e;
        } finally {
          if (!spanEnded) {
            spanEnded = true;

            if (taskContext.ctx) {
              const usageSample = usage.stop(usageMeasurement);
              const machine = taskContext.ctx.machine;

              span.setAttributes({
                [SemanticInternalAttributes.USAGE_DURATION_MS]: usageSample.cpuTime,
                [SemanticInternalAttributes.USAGE_COST_IN_CENTS]: machine?.centsPerMs
                  ? usageSample.cpuTime * machine.centsPerMs
                  : 0,
              });
            }

            span.end(clock.preciseNow());
          }
        }
      }
    );
  }

  startSpan(name: string, options?: SpanOptions, ctx?: Context) {
    const parentContext = ctx ?? context.active();

    const attributes = options?.attributes ?? {};

    const span = this.tracer.startSpan(name, options, parentContext);

    return span;
  }
}
