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
    ["/%61pi/v1/runs", "/api/v1/runs"],
    ["/API/v1/Runs", "/api/v1/runs"],
    ["/%6Ftel/v1/traces", "/otel/v1/traces"],
    // An encoded separator stays inside its segment, as Remix keeps it.
    ["/api/a%2Fb", "/api/a%2fb"],
    // Remix falls back to the raw path when a segment is malformed.
    ["/API/%E0%A4%A", "/api/%e0%a4%a"],
  ])("normalizes %s like the application router", (url, expected) => {
    expect(getRouterPath({ url })).toBe(expected);
  });

  it("matches complete path segments only", () => {
    expect(pathHasPrefix("/realtime", "/realtime")).toBe(true);
    expect(pathHasPrefix("/realtime/v1/runs", "/realtime")).toBe(true);
    expect(pathHasPrefix("/realtime-admin", "/realtime")).toBe(false);
  });
});
