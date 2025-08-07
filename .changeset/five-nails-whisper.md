---
"@trigger.dev/sdk": patch
---

External Trace Correlation & OpenTelemetry Package Updates.

| Package | Previous Version | New Version | Change Type |
|---------|------------------|-------------|-------------|
| `@opentelemetry/api` | 1.9.0 | 1.9.0 | No change (stable API) |
| `@opentelemetry/api-logs` | 0.52.1 | 0.203.0 | Major update |
| `@opentelemetry/core` | - | 2.0.1 | New dependency |
| `@opentelemetry/exporter-logs-otlp-http` | 0.52.1 | 0.203.0 | Major update |
| `@opentelemetry/exporter-trace-otlp-http` | 0.52.1 | 0.203.0 | Major update |
| `@opentelemetry/instrumentation` | 0.52.1 | 0.203.0 | Major update |
| `@opentelemetry/instrumentation-fetch` | 0.52.1 | 0.203.0 | Major update |
| `@opentelemetry/resources` | 1.25.1 | 2.0.1 | Major update |
| `@opentelemetry/sdk-logs` | 0.52.1 | 0.203.0 | Major update |
| `@opentelemetry/sdk-node` | 0.52.1 | - | Removed (functionality consolidated) |
| `@opentelemetry/sdk-trace-base` | 1.25.1 | 2.0.1 | Major update |
| `@opentelemetry/sdk-trace-node` | 1.25.1 | 2.0.1 | Major update |
| `@opentelemetry/semantic-conventions` | 1.25.1 | 1.36.0 | Minor update |

### External trace correlation and propagation

We will now correlate your external traces with trigger.dev traces and logs when using our external exporters:

```ts
import { defineConfig } from "@trigger.dev/sdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF,
  dirs: ["./src/trigger"],
  telemetry: {
    logExporters: [
      new OTLPLogExporter({
        url: "https://api.axiom.co/v1/logs",
        headers: {
          Authorization: `Bearer ${process.env.AXIOM_TOKEN}`,
          "X-Axiom-Dataset": "test",
        },
      }),
    ],
    exporters: [
      new OTLPTraceExporter({
        url: "https://api.axiom.co/v1/traces",
        headers: {
          Authorization: `Bearer ${process.env.AXIOM_TOKEN}`,
          "X-Axiom-Dataset": "test",
        },
      }),
    ],
  },
  maxDuration: 3600,
});
```

You can also now propagate your external trace context when calling back into your own backend infra from inside a trigger.dev task:

```ts
import { otel, task } from "@trigger.dev/sdk";
import { context, propagation } from "@opentelemetry/api";

async function callNextjsApp() {
  return await otel.withExternalTrace(async () => {
    const headersObject = {};

    // Now context.active() refers to your external trace context
    propagation.inject(context.active(), headersObject);

    const result = await fetch("http://localhost:3000/api/demo-call-from-trigger", {
      headers: new Headers(headersObject),
      method: "POST",
      body: JSON.stringify({
        message: "Hello from Trigger.dev",
      }),
    });

    return result.json();
  });
}

export const myTask = task({
  id: "my-task",
  run: async (payload: any) => {
    await callNextjsApp()
  }
})
```


