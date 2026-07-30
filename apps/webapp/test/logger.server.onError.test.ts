import { beforeEach, describe, expect, it, vi } from "vitest";

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();

vi.mock("@sentry/remix", () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

describe("logger.server Logger.onError", () => {
  beforeEach(() => {
    captureExceptionMock.mockClear();
    captureMessageMock.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("redacts the extra payload sent to Sentry on the captureMessage path", async () => {
    const { logger } = await import("~/services/logger.server");

    logger.error("something failed", {
      payload: { secret: "do-not-leak" },
      apiKey: "tr_prod_should_not_leak",
    });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [, options] = captureMessageMock.mock.calls[0] as [string, { extra: unknown }];

    expect(JSON.stringify(options.extra)).not.toContain("do-not-leak");
    expect(JSON.stringify(options.extra)).not.toContain("tr_prod_should_not_leak");
  });

  it("redacts the exception and extra payload sent to Sentry", async () => {
    const { logger } = await import("~/services/logger.server");
    const error = new Error("tr_prod_should_not_leak");
    error.stack = "Bearer secret-token";

    logger.error("boom", {
      error,
      payload: { secret: "do-not-leak" },
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedError, options] = captureExceptionMock.mock.calls[0] as [
      Error,
      { extra: unknown },
    ];

    expect(capturedError).not.toBe(error);
    expect(capturedError.message).not.toContain("tr_prod_should_not_leak");
    expect(capturedError.stack).not.toContain("secret-token");
    expect(JSON.stringify(options.extra)).not.toContain("do-not-leak");
  });

  it("still forwards non-sensitive extra fields", async () => {
    const { logger } = await import("~/services/logger.server");

    logger.error("something failed", { runId: "run_123", keep: "this stays" });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [, options] = captureMessageMock.mock.calls[0] as [
      string,
      { extra: Record<string, unknown> },
    ];

    expect(options.extra.runId).toBe("run_123");
    expect(options.extra.keep).toBe("this stays");
  });
});
