import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApiOnlyServiceMiddleware,
  servesStaticFiles,
  type ApiOnlyServiceMode,
} from "./apiOnlyService";

const APP_ORIGIN = "https://cloud.example";
const ASSET_BODY = "console.log('dashboard bundle');";

let buildDir: string;

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "api-only-service-"));
  mkdirSync(join(buildDir, "assets"));
  writeFileSync(join(buildDir, "assets", "entry.js"), ASSET_BODY);
  writeFileSync(join(buildDir, "favicon.ico"), "icon");
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

function createApp(mode: ApiOnlyServiceMode) {
  const logs: string[] = [];
  const app = express();
  app.use(
    createApiOnlyServiceMiddleware({ mode, appOrigin: APP_ORIGIN, log: (line) => logs.push(line) })
  );
  if (servesStaticFiles(mode)) {
    app.use("/assets", express.static(join(buildDir, "assets")));
    app.use(express.static(buildDir));
  }
  app.use((req, res) => {
    res.status(200).send(`app route ${req.method} ${req.path}`);
  });
  return { app, logs };
}

describe("API_ONLY_SERVICE_MODE=enforce through Express", () => {
  it("passes machine paths through to the app", async () => {
    const { app } = createApp("enforce");

    await request(app).get("/api/v1/runs").expect(200, "app route GET /api/v1/runs");
    await request(app).post("/engine/v1/dev/dequeue").expect(200);
    await request(app).post("/otel/v1/traces").expect(200);
    await request(app).post("/webhooks/v1/ingest/op_123").expect(200);
    await request(app).get("/webhooks/v1/ingest/op_123?challenge=abc").expect(200);
    await request(app).post("/webhooks/v1/accounts").expect(200);
    await request(app).get("/projects/v3/proj_123/metrics").expect(200);
    await request(app).post("/admin/api/v1/webhooks/partitions/bootstrap").expect(200);
    await request(app).get("/healthcheck").expect(200);
  });

  it("redirects dashboard pages and refuses dashboard actions", async () => {
    const { app, logs } = createApp("enforce");

    await request(app)
      .get("/login?redirectTo=%2F")
      .expect(302)
      .expect("Location", `${APP_ORIGIN}/login?redirectTo=%2F`);
    await request(app).post("/login/magic").expect(404);
    await request(app).get("/projects/v3/proj_123/runs").expect(302);

    expect(logs).toHaveLength(3);
    expect(JSON.parse(logs[0])).toMatchObject({
      path: "/login",
      decision: "redirect",
      enforced: true,
    });
  });

  it("serves no dashboard assets, including through an encoded separator", async () => {
    const { app } = createApp("enforce");

    await request(app)
      .get("/assets/entry.js")
      .expect(302)
      .expect("Location", `${APP_ORIGIN}/assets/entry.js`);
    await request(app).get("/favicon.ico").expect(302);

    const encoded = await request(app).get("/api/..%2fassets/entry.js");
    expect(encoded.text).not.toContain(ASSET_BODY);

    const encodedBackslash = await request(app).get("/api/..%5cassets%5centry.js");
    expect(encodedBackslash.text).not.toContain(ASSET_BODY);
  });
});

describe("API_ONLY_SERVICE_MODE=report through Express", () => {
  it("serves everything as before and logs dashboard requests", async () => {
    const { app, logs } = createApp("report");

    await request(app).get("/assets/entry.js").expect(200, ASSET_BODY);
    await request(app).get("/login").expect(200, "app route GET /login");
    await request(app).get("/api/v1/runs").expect(200);

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ path: "/assets/entry.js", decision: "redirect", enforced: false }),
      expect.objectContaining({ path: "/login", decision: "redirect", enforced: false }),
    ]);
  });
});
