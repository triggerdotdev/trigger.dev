import { describe, expect, it } from "vitest";
import { getRouterPath, pathHasPrefix, sanitizeHttpUrl } from "../app/utils/sanitizeHttpUrl.js";

describe("sanitizeHttpUrl", () => {
  it.each([
    ["/magic?token=secret", "/magic"],
    [
      "/orgs/acme/projects/demo/runs?search=needle&query=status%3Afailed&_data=routes&tableState=open",
      "/orgs/acme/projects/demo/runs",
    ],
    ["/account/authorization-code/code_secret", "/account/authorization-code/[redacted]"],
    [
      "/account/authorization-code/code_secret?utm_source=cli",
      "/account/authorization-code/[redacted]",
    ],
    ["/healthcheck", "/healthcheck"],
  ])("sanitizes %s", (value, expected) => {
    expect(sanitizeHttpUrl(value)).toBe(expected);
  });
});

describe("getRouterPath", () => {
  it.each([
    ["/realtime/v1/runs?cursor=1", "/realtime/v1/runs"],
    ["/realtime/../api/v1/tasks", "/api/v1/tasks"],
    ["/realtime/%2e%2e/api/v1/tasks", "/api/v1/tasks"],
    ["/ws?token=value", "/ws"],
    ["/socket.io/?transport=websocket", "/socket.io/"],
  ])("normalizes %s like the application router", (url, expected) => {
    expect(getRouterPath({ url })).toBe(expected);
  });

  it("rejects malformed absolute request targets", () => {
    expect(getRouterPath({ url: "http://[" })).toBeUndefined();
  });

  it("matches complete path segments only", () => {
    expect(pathHasPrefix("/realtime", "/realtime")).toBe(true);
    expect(pathHasPrefix("/realtime/v1/runs", "/realtime")).toBe(true);
    expect(pathHasPrefix("/realtime-admin", "/realtime")).toBe(false);
  });
});
