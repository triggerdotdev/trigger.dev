import { taskContext } from "@trigger.dev/core/v3";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { update } from "./envvars.js";

describe("envvars.update outside a task context", () => {
  let server: Server | undefined;
  let requests: { method?: string; url?: string; body: string }[];
  let previousApiUrl: string | undefined;
  let previousSecretKey: string | undefined;
  let previousAccessToken: string | undefined;

  beforeEach(async () => {
    requests = [];
    previousApiUrl = process.env.TRIGGER_API_URL;
    previousSecretKey = process.env.TRIGGER_SECRET_KEY;
    previousAccessToken = process.env.TRIGGER_ACCESS_TOKEN;

    delete process.env.TRIGGER_SECRET_KEY;

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    const { port } = server!.address() as AddressInfo;
    process.env.TRIGGER_API_URL = `http://127.0.0.1:${port}`;
    process.env.TRIGGER_ACCESS_TOKEN = "tr_test_token";
  });

  afterEach(async () => {
    if (previousApiUrl === undefined) {
      delete process.env.TRIGGER_API_URL;
    } else {
      process.env.TRIGGER_API_URL = previousApiUrl;
    }

    if (previousSecretKey === undefined) {
      delete process.env.TRIGGER_SECRET_KEY;
    } else {
      process.env.TRIGGER_SECRET_KEY = previousSecretKey;
    }

    if (previousAccessToken === undefined) {
      delete process.env.TRIGGER_ACCESS_TOKEN;
    } else {
      process.env.TRIGGER_ACCESS_TOKEN = previousAccessToken;
    }

    const running = server;
    server = undefined;

    if (running) {
      await new Promise<void>((resolve, reject) =>
        running.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("sends a PUT for the named variable (regression #4264)", async () => {
    expect(taskContext.ctx).toBeUndefined();

    await expect(update("proj_xxx", "staging", "MY_VAR", { value: "hello" })).resolves.toEqual({
      success: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/projects/proj_xxx/envvars/staging/MY_VAR");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ value: "hello" });
  });

  it("throws a descriptive error when name is missing", () => {
    expect(taskContext.ctx).toBeUndefined();

    expect(() =>
      update("proj_xxx", "staging", undefined as unknown as string, { value: "hello" })
    ).toThrow("name is required");

    expect(requests).toHaveLength(0);
  });
});

describe("envvars.update inside a task context", () => {
  let server: Server | undefined;
  let requests: { method?: string; url?: string; body: string }[];
  let previousApiUrl: string | undefined;
  let previousSecretKey: string | undefined;
  let previousAccessToken: string | undefined;

  beforeEach(async () => {
    requests = [];
    previousApiUrl = process.env.TRIGGER_API_URL;
    previousSecretKey = process.env.TRIGGER_SECRET_KEY;
    previousAccessToken = process.env.TRIGGER_ACCESS_TOKEN;

    delete process.env.TRIGGER_SECRET_KEY;

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    const { port } = server!.address() as AddressInfo;
    process.env.TRIGGER_API_URL = `http://127.0.0.1:${port}`;
    process.env.TRIGGER_ACCESS_TOKEN = "tr_test_token";

    taskContext.setGlobalLocation({
      ctx: {
        project: { id: "proj_ctx_id", ref: "proj_ctx_ref", name: "Project Ctx" },
        environment: { id: "env_ctx_id", slug: "dev", type: "DEVELOPMENT" },
        organization: { id: "org_ctx_id", slug: "org_ctx", title: "Org Ctx" },
        run: { id: "run_ctx_id", isTest: false },
        task: { id: "task_ctx_id", filePath: "task.ts", exportName: "task" },

      },
    });
  });

  afterEach(async () => {
    taskContext.clear();

    if (previousApiUrl === undefined) {
      delete process.env.TRIGGER_API_URL;
    } else {
      process.env.TRIGGER_API_URL = previousApiUrl;
    }

    if (previousSecretKey === undefined) {
      delete process.env.TRIGGER_SECRET_KEY;
    } else {
      process.env.TRIGGER_SECRET_KEY = previousSecretKey;
    }

    if (previousAccessToken === undefined) {
      delete process.env.TRIGGER_ACCESS_TOKEN;
    } else {
      process.env.TRIGGER_ACCESS_TOKEN = previousAccessToken;
    }

    const running = server;
    server = undefined;

    if (running) {
      await new Promise<void>((resolve, reject) =>
        running.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("correctly parses explicit projectRef, slug, name parameters when taskContext exists", async () => {
    await expect(update("proj_explicit", "staging", "MY_VAR", { value: "hello" })).resolves.toEqual({
      success: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/projects/proj_explicit/envvars/staging/MY_VAR");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ value: "hello" });
  });

  it("correctly uses taskContext defaults when only name and params are provided", async () => {
    await expect(update("MY_VAR", { value: "hello_context" })).resolves.toEqual({
      success: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/projects/proj_ctx_ref/envvars/dev/MY_VAR");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ value: "hello_context" });
  });
});

