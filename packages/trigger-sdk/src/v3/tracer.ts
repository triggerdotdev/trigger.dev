import { TriggerTracer } from "@trigger.dev/core/v3";
import * as packageJson from "../../package.json";
import { Span, SpanOptions } from "@opentelemetry/api";

export const tracer = new TriggerTracer({ name: "@trigger.dev/sdk", version: packageJson.version });

export function trace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
  return tracer.startActiveSpan(name, fn, options);
}
