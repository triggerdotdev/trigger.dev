import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("~/services/logger.server", () => ({ logger }));

import {
  callVercelWithRecovery,
  VercelSchemas,
  wrapVercelCallWithRecovery,
} from "~/models/vercelSdkRecovery.server";
import { toVercelApiError, VERCEL_API_ERROR_MESSAGE } from "~/v3/vercel/vercelApiError";

const SENTINEL_SECRET = "provider-sentinel-secret";

class ResponseValidationError extends Error {
  rawValue: unknown;
  response: { status: number; body: string };

  constructor(rawValue: unknown, status: number) {
    super(`Provider response included ${SENTINEL_SECRET}`);
    this.rawValue = rawValue;
    this.response = { status, body: `body:${SENTINEL_SECRET}` };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Vercel SDK recovery diagnostics", () => {
  it("replaces a recovery failure before error conversion and downstream logging", async () => {
    const result = await callVercelWithRecovery(
      Promise.reject(new ResponseValidationError({ token: SENTINEL_SECRET }, 403)),
      VercelSchemas.getTeam,
      { context: "validateVercelToken" }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;

    expect(result.error).toEqual({
      message: VERCEL_API_ERROR_MESSAGE,
      authInvalid: true,
      errorType: "ResponseValidationError",
      status: 403,
    });

    const apiError = toVercelApiError(result.error);
    const downstreamDiagnostic = {
      error: apiError.message,
      authInvalid: apiError.authInvalid,
    };

    expect(downstreamDiagnostic).toEqual({
      error: VERCEL_API_ERROR_MESSAGE,
      authInvalid: true,
    });
    expect(JSON.stringify({ replacement: result.error, downstreamDiagnostic })).not.toContain(
      SENTINEL_SECRET
    );
  });

  it("returns and logs only fixed diagnostics from the repository wrapper", async () => {
    const result = await wrapVercelCallWithRecovery(
      Promise.reject(new ResponseValidationError({ token: SENTINEL_SECRET }, 422)),
      VercelSchemas.getTeam,
      "Failed to fetch Vercel team",
      { teamId: "team_123" },
      toVercelApiError
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;

    expect(result.error).toEqual({
      message: "Failed to fetch Vercel team",
      authInvalid: false,
    });
    expect(logger.error).toHaveBeenCalledWith("Failed to fetch Vercel team", {
      teamId: "team_123",
      errorType: "ResponseValidationError",
      status: 422,
      authInvalid: false,
    });

    logger.warn("Representative downstream Vercel failure", {
      error: result.error.message,
      authInvalid: result.error.authInvalid,
    });

    expect(logger.warn).toHaveBeenCalledWith("Representative downstream Vercel failure", {
      error: "Failed to fetch Vercel team",
      authInvalid: false,
    });
    expect(JSON.stringify({ error: result.error, calls: logger })).not.toContain(SENTINEL_SECRET);
  });

  it("retains rawValue-derived functional data after successful recovery", async () => {
    const result = await callVercelWithRecovery(
      Promise.reject(
        new ResponseValidationError(
          { key: "API_TOKEN", value: SENTINEL_SECRET, providerField: "retained" },
          422
        )
      ),
      VercelSchemas.getProjectEnv,
      { context: "resolveEnvVarValue" }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value).toEqual({
      key: "API_TOKEN",
      value: SENTINEL_SECRET,
      providerField: "retained",
    });
    expect(logger.warn).toHaveBeenCalledWith("Recovered data from Vercel SDK validation error", {
      context: "resolveEnvVarValue",
      errorType: "ResponseValidationError",
      status: 422,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SENTINEL_SECRET);
  });
});
