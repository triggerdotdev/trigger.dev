import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import { describe, expect, it } from "vitest";
import { sanitizeWorkerHeaders } from "../app/v3/services/worker/sanitizeWorkerHeaders.js";

// Runs before request headers are logged. The security property: secret-bearing
// managed-worker headers must never make it into the sanitized (loggable)
// object.
describe("sanitizeWorkerHeaders", () => {
  const build = () =>
    new Headers({
      authorization: "Bearer tr_secret",
      cookie: "__session=abc",
      [WORKER_HEADERS.MANAGED_SECRET]: "cluster-shared-secret",
      [WORKER_HEADERS.INSTANCE_NAME]: "supervisor-1",
      "content-type": "application/json",
    });

  it("strips the managed worker secret (the leak this fixes)", () => {
    const out = sanitizeWorkerHeaders(build());
    expect(out[WORKER_HEADERS.MANAGED_SECRET]).toBeUndefined();
  });

  it("strips authorization and cookie", () => {
    const out = sanitizeWorkerHeaders(build());
    expect(out["authorization"]).toBeUndefined();
    expect(out["cookie"]).toBeUndefined();
  });

  it("preserves non-sensitive headers", () => {
    const out = sanitizeWorkerHeaders(build());
    expect(out["content-type"]).toBe("application/json");
    expect(out[WORKER_HEADERS.INSTANCE_NAME]).toBe("supervisor-1");
  });

  it("matches header names case-insensitively", () => {
    const h = new Headers({
      Authorization: "Bearer x",
      "X-Trigger-Worker-Managed-Secret": "s",
    });
    const out = sanitizeWorkerHeaders(h);
    // Headers lower-cases keys; both must be gone regardless of input casing.
    expect(Object.keys(out)).toHaveLength(0);
  });
});
