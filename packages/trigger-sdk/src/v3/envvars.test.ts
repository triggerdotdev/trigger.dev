import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager, taskContext } from "@trigger.dev/core/v3";
import { configure } from "./auth.js";
import { update } from "./envvars.js";

type CapturedRequest = {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  body?: string;
};

function installFetchSpy() {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const headers = new Headers(init?.headers);
    captured.push({
      url,
      method: init?.method,
      authorization: headers.get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(
      JSON.stringify({
        name: "DATABASE_URL",
        value: "postgres://...",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;

  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("envvars", () => {
  let fetchSpy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    apiClientManager.disable();
    taskContext.disable();
    fetchSpy = installFetchSpy();
  });

  afterEach(() => {
    fetchSpy.restore();
    apiClientManager.disable();
    taskContext.disable();
    vi.unstubAllEnvs();
  });

  describe("update outside task context", () => {
    it("successfully updates an environment variable without ReferenceError (#4264)", async () => {
      configure({ accessToken: "tr_test_token" });

      await update("proj_123", "prod", "DATABASE_URL", {
        value: "postgres://localhost:5432/mydb",
      });

      expect(fetchSpy.captured).toHaveLength(1);
      const req = fetchSpy.captured[0]!;
      expect(req.url).toContain("/api/v1/projects/proj_123/envvars/prod/DATABASE_URL");
      expect(req.method).toBe("PUT");
      expect(req.authorization).toBe("Bearer tr_test_token");
      expect(req.body).toBe(JSON.stringify({ value: "postgres://localhost:5432/mydb" }));
    });

    it("throws when name is missing or not a string", async () => {
      configure({ accessToken: "tr_test_token" });

      expect(() =>
        update("proj_123", "prod", undefined as any, { value: "test" })
      ).toThrow("name is required");
    });

    it("throws when projectRef is missing", async () => {
      configure({ accessToken: "tr_test_token" });

      expect(() =>
        update("", "prod", "MY_VAR", { value: "test" })
      ).toThrow("projectRef is required");
    });

    it("throws when slug is missing", async () => {
      configure({ accessToken: "tr_test_token" });

      expect(() =>
        update("proj_123", undefined as any, "MY_VAR", { value: "test" })
      ).toThrow("slug is required");
    });

    it("throws when params is missing", async () => {
      configure({ accessToken: "tr_test_token" });

      expect(() =>
        update("proj_123", "prod", "MY_VAR", undefined as any)
      ).toThrow("params is required");
    });
  });
});
