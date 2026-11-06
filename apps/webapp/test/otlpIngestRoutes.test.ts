import express from "express";
import request from "supertest";
import { describe, it } from "vitest";
import { blockOtlpIngestRoutes } from "~/utils/otlpIngestRoutes";

function createApp() {
  const app = express();
  app.use(blockOtlpIngestRoutes);
  app.use((req, res) => {
    res.status(200).send(`app route ${req.method} ${req.path}`);
  });
  return app;
}

describe("blockOtlpIngestRoutes", () => {
  it.each(["/otel/v1/traces", "/OTEL/v1/traces", "/%6Ftel/v1/logs"])(
    "catches %s reaching the OTLP route on a service that turned it off",
    async (path) => {
      await request(createApp()).post(path).send("{}").expect(404, "Not Found");
    }
  );

  it.each(["/api/v1/tasks/otel-export/trigger", "/otelx/v1/traces"])(
    "catches an over-broad match blocking %s",
    async (path) => {
      await request(createApp()).post(path).expect(200);
    }
  );
});
