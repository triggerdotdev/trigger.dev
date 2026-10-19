import type { Attributes, Context, Exception } from "@opentelemetry/api";
import { globalErrorHandler } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";

const RUN_LINKING_KEYS = [
  SemanticInternalAttributes.ENVIRONMENT_ID,
  SemanticInternalAttributes.ENVIRONMENT_TYPE,
  SemanticInternalAttributes.ORGANIZATION_ID,
  SemanticInternalAttributes.PROJECT_ID,
  SemanticInternalAttributes.RUN_ID,
  SemanticInternalAttributes.ATTEMPT_NUMBER,
  SemanticInternalAttributes.TASK_SLUG,
  SemanticInternalAttributes.MACHINE_ID,
  SemanticInternalAttributes.WORKER_ID,
  SemanticInternalAttributes.WORKER_VERSION,
  SemanticInternalAttributes.GEN_AI_CONVERSATION_ID,
];

const PROTECTED_ATTRIBUTE_KEYS = new Set<string>([
  ...RUN_LINKING_KEYS,
  ...RUN_LINKING_KEYS.map((key) => `${SemanticInternalAttributes.METADATA}.${key}`),
  SemanticInternalAttributes.SPAN_PARTIAL,
  SemanticInternalAttributes.SKIP_SPAN_PARTIAL,
  SemanticInternalAttributes.SPAN_ID,
  SemanticInternalAttributes.SPAN_ATTEMPT,
  SemanticInternalAttributes.ENTITY_TYPE,
  SemanticInternalAttributes.ENTITY_ID,
  SemanticInternalAttributes.STYLE_ICON,
  SemanticInternalAttributes.STYLE_VARIANT,
  SemanticInternalAttributes.ORIGINAL_RUN_ID,
  SemanticInternalAttributes.ATTEMPT_EXECUTION_COUNT,
  SemanticInternalAttributes.TASK_EVENT_STORE,
]);

function snapshotProtectedAttributes(span: ReadableSpan): Attributes {
  const snapshot: Attributes = {};

  for (const [key, value] of Object.entries(span.attributes)) {
    if (PROTECTED_ATTRIBUTE_KEYS.has(key)) {
      snapshot[key] = value;
    }
  }

  return snapshot;
}

function restoreProtectedAttributes(span: ReadableSpan, snapshot: Attributes) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (span.attributes[key] !== value) {
      span.attributes[key] = value;
    }
  }
}

function guarded(span: ReadableSpan, callback: () => void) {
  const snapshot = snapshotProtectedAttributes(span);

  try {
    callback();
  } catch (error) {
    globalErrorHandler(error as Exception);
  }

  restoreProtectedAttributes(span, snapshot);
}

/**
 * Runs a user-supplied span processor ahead of the Trigger.dev processors.
 *
 * The user processor can rewrite or remove any attribute, which is how span
 * content gets redacted before export. The attributes the platform uses to
 * link a span to its run and to stitch partial and final spans together are
 * restored afterwards. A throwing processor is reported to the OTel error
 * handler instead of escaping into `startSpan` or `span.end()`.
 */
export class UserSpanProcessorWrapper implements SpanProcessor {
  constructor(private readonly _processor: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    guarded(span, () => this._processor.onStart(span, parentContext));
  }

  onEnding(span: Span): void {
    const onEnding = this._processor.onEnding?.bind(this._processor);

    if (onEnding) {
      guarded(span, () => onEnding(span));
    }
  }

  onEnd(span: ReadableSpan): void {
    guarded(span, () => this._processor.onEnd(span));
  }

  forceFlush(): Promise<void> {
    return this._processor.forceFlush();
  }

  shutdown(): Promise<void> {
    return this._processor.shutdown();
  }
}
