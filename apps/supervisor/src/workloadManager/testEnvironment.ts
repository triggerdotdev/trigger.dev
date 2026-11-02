// env.ts parses process.env when it is imported, so a test that needs it imports this first.
Object.assign(process.env, {
  TRIGGER_API_URL: "http://localhost:3030",
  TRIGGER_WORKER_TOKEN: "test-token",
  MANAGED_WORKER_SECRET: "test-secret",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
});
