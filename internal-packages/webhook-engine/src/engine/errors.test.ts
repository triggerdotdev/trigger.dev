import { describe, expect, it } from "vitest";
import { isInfrastructureError, WebhookInfrastructureError } from "./errors.js";

function httpError(status: number) {
  return Object.assign(new Error(`append failed: ${status}`), { status });
}

describe("isInfrastructureError", () => {
  it("counts our own dependencies being down", () => {
    expect(isInfrastructureError(new WebhookInfrastructureError("x"))).toBe(true);
    expect(
      isInfrastructureError(
        Object.assign(new Error("Can't reach database server"), {
          name: "PrismaClientKnownRequestError",
          code: "P1001",
        })
      )
    ).toBe(true);
    expect(isInfrastructureError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isInfrastructureError(new Error("CLUSTERDOWN The cluster is down"))).toBe(true);
    expect(isInfrastructureError(new Error("Connection is closed."))).toBe(true);
    expect(isInfrastructureError(new Error("Command timed out"))).toBe(true);
    expect(isInfrastructureError(new Error("None of startup nodes is available"))).toBe(true);
    expect(
      isInfrastructureError(
        new Error("Too many Cluster redirections. Last error: Error: Connection is closed.")
      )
    ).toBe(true);
    expect(
      isInfrastructureError(
        new Error(
          "Too many Cluster redirections. Last error: ReplyError: CLUSTERDOWN The cluster is down"
        )
      )
    ).toBe(true);
    expect(
      isInfrastructureError(
        Object.assign(new Error("Failed to refresh slots cache."), {
          name: "ClusterAllFailedError",
        })
      )
    ).toBe(true);
    expect(
      isInfrastructureError(
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })
      )
    ).toBe(true);
  });

  it("counts a server error or a rate limit from an HTTP dependency", () => {
    expect(isInfrastructureError(httpError(503))).toBe(true);
    expect(isInfrastructureError(httpError(500))).toBe(true);
    expect(isInfrastructureError(httpError(429))).toBe(true);
  });

  it("does not count a message that only embeds Redis failure text", () => {
    for (const taskId of [
      "Too many Cluster redirections. Last error: Error: Connection is closed.",
      "Connection is closed.",
      "x CLUSTERDOWN y",
      "None of startup nodes is available",
    ]) {
      expect(
        isInfrastructureError(
          new Error(
            `Cannot trigger ${taskId} as the queue size limit for this environment has been reached. The maximum size is 10`
          )
        )
      ).toBe(false);
    }
  });

  it("does not count failures of the delivery itself, or unknown errors", () => {
    expect(isInfrastructureError(httpError(400))).toBe(false);
    expect(isInfrastructureError(httpError(404))).toBe(false);
    expect(
      isInfrastructureError(
        Object.assign(new Error("Unique constraint"), {
          name: "PrismaClientKnownRequestError",
          code: "P2002",
        })
      )
    ).toBe(false);
    expect(isInfrastructureError(new Error("Task not found"))).toBe(false);
    expect(isInfrastructureError("boom")).toBe(false);
    expect(isInfrastructureError(null)).toBe(false);
  });
});
