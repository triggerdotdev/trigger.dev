import { describe, expect, it } from "vitest";
import { ComputeClientError } from "@internal/compute";
import { isRetryableCreateError, runnerNameForAttempt } from "./compute.js";

describe("runnerNameForAttempt", () => {
  it("keeps the unsuffixed name for the first attempt", () => {
    expect(runnerNameForAttempt("runner-abc123", 1)).toBe("runner-abc123");
  });

  it("suffixes retry attempts deterministically", () => {
    expect(runnerNameForAttempt("runner-abc123", 2)).toBe("runner-abc123-r2");
    expect(runnerNameForAttempt("runner-abc123", 3)).toBe("runner-abc123-r3");
  });
});

describe("isRetryableCreateError", () => {
  it("retries statuses where the create definitely did not commit", () => {
    expect(isRetryableCreateError(new ComputeClientError(500, "tap busy", "http://gw"))).toBe(
      true
    );
    expect(isRetryableCreateError(new ComputeClientError(503, "no placement", "http://gw"))).toBe(
      true
    );
  });

  it("does not retry lost-response statuses (create may have committed)", () => {
    expect(isRetryableCreateError(new ComputeClientError(502, "bad gateway", "http://gw"))).toBe(
      false
    );
    expect(
      isRetryableCreateError(new ComputeClientError(504, "gateway timeout", "http://gw"))
    ).toBe(false);
  });

  it("does not retry 4xx responses", () => {
    expect(isRetryableCreateError(new ComputeClientError(400, "bad request", "http://gw"))).toBe(
      false
    );
    expect(isRetryableCreateError(new ComputeClientError(409, "conflict", "http://gw"))).toBe(
      false
    );
  });

  it("does not retry timeouts (instance may still be provisioning)", () => {
    expect(isRetryableCreateError(new DOMException("timed out", "TimeoutError"))).toBe(false);
  });

  it("retries network-level fetch failures", () => {
    expect(isRetryableCreateError(new TypeError("fetch failed"))).toBe(true);
  });

  it("does not retry unknown errors", () => {
    expect(isRetryableCreateError(new Error("something else"))).toBe(false);
    expect(isRetryableCreateError("string error")).toBe(false);
  });
});
