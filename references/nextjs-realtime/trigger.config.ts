import { defineConfig } from "@trigger.dev/sdk/v3";
import { rscExtension } from "@trigger.dev/rsc";
import { AISDKExporter } from "langsmith/vercel";
import { Client } from "langsmith";

class LangsmithSpanExporterWrapper {
  constructor(
    private underlyingExporter: any,
    private transformSpan: (span: any) => any | undefined = (span) => {
      if (span.attributes["$span.partial"]) {
        // Skip partial spans
        return;
      }

      // Check if this is an attempt span
      if (span.name.startsWith("Attempt ")) {
        // Create a new span that wraps the original but modifies spanContext
        const spanContext = span.spanContext();

        return {
          ...span,
          spanContext: () => spanContext,
          parentSpanId: undefined,
        };
      }
      return span;
    }
  ) {}

  export(spans: any[], resultCallback: (result: any) => void): void {
    const modifiedSpans = spans.map(this.transformSpan);
    this.underlyingExporter.export(modifiedSpans.filter(Boolean), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.underlyingExporter.shutdown();
  }

  forceFlush?(): Promise<void> {
    return this.underlyingExporter.forceFlush
      ? this.underlyingExporter.forceFlush()
      : Promise.resolve();
  }
}

const client = new Client();

const exporter = new AISDKExporter({
  debug: true,
  client,
});

export default defineConfig({
  project: "proj_bzhdaqhlymtuhlrcgbqy",
  dirs: ["./src/trigger"],
  exporters: [new LangsmithSpanExporterWrapper(exporter)],
  build: {
    extensions: [rscExtension({ reactDomEnvironment: "worker" })],
  },
});
