import { describe, expect, it } from "vitest";
import { vercelErrorLogMetadata } from "~/v3/vercel/vercelErrorLogMetadata";

class ResponseValidationError extends Error {
  rawValue = { envs: [{ key: "SECRET", value: "sensitive-value" }] };
  response = { status: 422, body: "sensitive-response" };
}

class UnexpectedProviderError extends Error {
  statusCode = 503;
  body = "sensitive-response";
}

describe("vercelErrorLogMetadata", () => {
  it("returns only allowlisted metadata for a validation error", () => {
    const metadata = vercelErrorLogMetadata(
      new ResponseValidationError("response included sensitive-value")
    );

    expect(metadata).toEqual({ errorType: "ResponseValidationError", status: 422 });
    expect(Object.keys(metadata)).toEqual(["errorType", "status"]);
  });

  it("preserves allowlisted provider and transport error names", () => {
    const forbidden = Object.assign(new Error("provider details"), {
      name: "Forbidden",
      statusCode: 403,
    });
    const timeout = Object.assign(new Error("provider details"), {
      name: "RequestTimeoutError",
    });

    expect(vercelErrorLogMetadata(forbidden)).toEqual({ errorType: "Forbidden", status: 403 });
    expect(vercelErrorLogMetadata(timeout)).toEqual({ errorType: "RequestTimeoutError" });
  });

  it("normalizes unknown error names while preserving a valid status", () => {
    expect(vercelErrorLogMetadata(new UnexpectedProviderError("provider details"))).toEqual({
      errorType: "Error",
      status: 503,
    });
  });

  it.each([undefined, null, "failure", { status: 99 }, { status: 600 }])(
    "does not include untrusted details from %j",
    (error) => {
      expect(vercelErrorLogMetadata(error)).toEqual({ errorType: "UnknownError" });
    }
  );
});
