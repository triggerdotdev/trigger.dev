/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { type ExportResult, ExportResultCode, hrTimeToMicroseconds } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export class LoggerSpanExporter implements SpanExporter {
  /**
   * Export spans.
   * @param spans
   * @param resultCallback
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    return this._sendSpans(spans, resultCallback);
  }

  /**
   * Shutdown the exporter.
   */
  shutdown(): Promise<void> {
    this._sendSpans([]);
    return this.forceFlush();
  }

  /**
   * Exports any pending spans in exporter
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * converts span info into more readable format
   * @param span
   */
  private _exportInfo(span: ReadableSpan) {
    const parentSpanId = span.parentSpanContext?.spanId;

    return {
      traceId: span.spanContext().traceId,
      parentId:
        parentSpanId && parentSpanId !== "" && parentSpanId !== "0000000000000000"
          ? parentSpanId
          : undefined,
      traceState: span.spanContext().traceState?.serialize(),
      message: span.name,
      spanId: span.spanContext().spanId,
      kind: span.kind,
      timestamp: hrTimeToMicroseconds(span.startTime),
      duration: hrTimeToMicroseconds(span.duration),
      attributes: span.attributes,
      status: span.status,
      events: span.events,
      links: span.links,
      level: "trace",
    };
  }

  /**
   * Showing spans in console
   * @param spans
   * @param done
   */
  private _sendSpans(spans: ReadableSpan[], done?: (result: ExportResult) => void): void {
    for (const span of spans) {
      console.log(JSON.stringify(this._exportInfo(span)));
    }
    if (done) {
      return done({ code: ExportResultCode.SUCCESS });
    }
  }
}
