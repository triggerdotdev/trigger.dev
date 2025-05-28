import { defineConfig } from "@trigger.dev/sdk";
import { pythonExtension } from "@trigger.dev/python/extension";
import { installPlaywrightChromium } from "./src/extensions/playwright";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  telemetry: {
    logExporters: [
      new OTLPLogExporter({
        url: "https://api.axiom.co/v1/logs",
        headers: {
          Authorization: `Bearer ${process.env.AXIOM_TOKEN}`,
          "X-Axiom-Dataset": "d3-chat-tester",
        },
      }),
    ],
    exporters: [
      new OTLPTraceExporter({
        url: "https://api.axiom.co/v1/traces",
        headers: {
          Authorization: `Bearer ${process.env.AXIOM_TOKEN}`,
          "X-Axiom-Dataset": "d3-chat-tester",
        },
      }),
    ],
  },
  maxDuration: 3600,
  build: {
    extensions: [
      // This is required to use the Python extension
      pythonExtension({
        requirementsFile: "./requirements.txt", // Optional: Path to your requirements file
        devPythonBinaryPath: `.venv/bin/python`, // Optional: Custom Python binary path
        scripts: ["src/trigger/python/**/*.py"], // List of Python scripts to include
      }),
      installPlaywrightChromium(),
    ],
  },
});
