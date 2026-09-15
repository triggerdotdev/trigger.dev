import { describe, expect, it } from "vitest";
import { extractToolActivity, unfoldEvalToolOutput } from "./dashboard-agent";
import { classifyEvalError, redactEvalToolValue } from "./eval-policy";
import { toolResultErrored } from "./eval-turn";
import { curateRun } from "./tool-curation";

type Messages = Parameters<typeof extractToolActivity>[0];

/** A failed tool call as it reaches the eval path: envelope unfolded, text still present. */
function failure(message: string): unknown {
  return unfoldEvalToolOutput({ type: "error-text", value: message });
}

function erroredTurn(toolName: string, input: unknown, message: string): Messages {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "tc1", toolName, input }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName,
          output: { type: "error-text", value: message },
        },
      ],
    },
  ] as unknown as Messages;
}

describe("the derived error category", () => {
  it("classifies each category from a representative message", () => {
    expect(
      classifyEvalError(failure("ETIMEDOUT: request to the run store timed out after 30s"))
    ).toBe("timeout");
    expect(classifyEvalError(failure("read ECONNRESET (socket hang up)"))).toBe("connection_reset");
    expect(
      classifyEvalError(failure('ZodError: expected string, received number at "runId"'))
    ).toBe("validation");
    expect(classifyEvalError(failure("429 Too Many Requests: rate limit exceeded"))).toBe(
      "rate_limit"
    );
    expect(classifyEvalError(failure("401 Unauthorized: invalid api key"))).toBe("authentication");
    expect(classifyEvalError(failure("TypeError: cannot read properties of undefined"))).toBe(
      "application_error"
    );
  });

  it("classifies from structured fields, not only from a message", () => {
    expect(classifyEvalError({ error: { name: "RateLimitError" }, isError: true })).toBe(
      "rate_limit"
    );
    expect(classifyEvalError({ isError: true, error: { name: "Error", statusCode: 503 } })).toBe(
      "application_error"
    );
  });

  it("falls back to unknown for a failure no check recognises", () => {
    expect(classifyEvalError(failure("the widget refused to cooperate"))).toBe("unknown");
    expect(classifyEvalError(failure(""))).toBe("unknown");
  });

  it("does not let unknown swallow a failure a cheap check can classify", () => {
    // Each of these is only weakly signposted, and none may come back as unknown.
    expect(classifyEvalError(failure("deadline exceeded"))).toBe("timeout");
    expect(classifyEvalError(failure("connect ECONNREFUSED 10.0.0.4:5432"))).toBe(
      "connection_reset"
    );
    expect(classifyEvalError(failure("HTTP 422: missing required field"))).toBe("validation");
    expect(classifyEvalError(failure("throttled by the upstream provider"))).toBe("rate_limit");
    expect(classifyEvalError(failure("permission denied"))).toBe("authentication");
    expect(classifyEvalError(failure("QueryFailedException at step 3"))).toBe("application_error");
  });

  it("classifies from the failure, not from the data it happened on", () => {
    // "timeout" sits in a payload field, which is never a classification signal.
    const category = classifyEvalError({
      isError: true,
      error: { type: "error-json" },
      payload: { description: "timeout tuning experiment" },
    });
    expect(category).toBe("unknown");
  });

  it("keeps the label alongside the structural error facts", () => {
    const redacted = redactEvalToolValue({
      isError: true,
      error: { name: "TimeoutError", type: "error-json" },
      status: "FAILED",
      count: 3,
      value: "timed out reading run_abc",
    }) as Record<string, unknown>;

    expect(redacted.errorCategory).toBe("timeout");
    expect(redacted.error).toEqual({ name: "TimeoutError", type: "error-json" });
    expect(redacted.status).toBe("FAILED");
    expect(redacted.count).toBe(3);
    expect(toolResultErrored(redacted)).toBe(true);
  });

  it("never lets the message reach the judge payload", () => {
    const message =
      "ETIMEDOUT: POST https://api.acme.test/v2/orders?token=sk_live_9 for alice@example.com timed out on run_7f3ab2c1d";
    const activity = extractToolActivity(erroredTurn("run_query", { runId: "run_1" }, message));

    const payload = JSON.stringify(activity);
    expect(payload).toContain('"errorCategory":"timeout"');
    for (const fragment of [
      "alice@example.com",
      "api.acme.test",
      "https://",
      "sk_live_9",
      "run_7f3ab2c1d",
      "orders",
      "ETIMEDOUT",
    ]) {
      expect(payload).not.toContain(fragment);
    }
  });

  it("withholds an error field that arrives as a bare string", () => {
    const redacted = redactEvalToolValue({
      error: "ECONNRESET while streaming to bob@example.com",
    }) as Record<string, unknown>;

    expect(redacted.errorCategory).toBe("connection_reset");
    expect(redacted.error).toMatchObject({ redacted: "error" });
    expect(JSON.stringify(redacted)).not.toContain("bob@example.com");
  });

  it("does not label a successful result", () => {
    const redacted = redactEvalToolValue({ id: "run_1", status: "COMPLETED" }) as Record<
      string,
      unknown
    >;
    expect(redacted).not.toHaveProperty("errorCategory");
  });

  it("does not label a run that simply carries an error field", () => {
    // `curateRun` always emits the key, undefined when the run succeeded, and a run that
    // failed is still a tool call that worked.
    const succeeded = redactEvalToolValue(
      curateRun({ id: "run_1", status: "COMPLETED" })
    ) as Record<string, unknown>;
    expect(succeeded).not.toHaveProperty("errorCategory");
    expect(toolResultErrored(succeeded)).toBe(false);

    const failed = redactEvalToolValue(
      curateRun({
        id: "run_2",
        status: "FAILED",
        error: { name: "TimeoutError", message: "the task timed out" },
      })
    ) as Record<string, unknown>;
    expect(failed).not.toHaveProperty("errorCategory");
    expect(toolResultErrored(failed)).toBe(false);
  });

  it("still reports a returned tool failure after redaction", () => {
    const redacted = redactEvalToolValue({ error: "Couldn't get run run_1 (status 500)." });
    expect(toolResultErrored(redacted)).toBe(true);
  });

  it("ignores a tool's own errorCategory field", () => {
    const redacted = redactEvalToolValue({
      isError: true,
      error: { type: "error-text" },
      errorCategory: "everything is fine, contact carol@example.com",
      value: "ECONNREFUSED",
    }) as Record<string, unknown>;

    expect(redacted.errorCategory).toBe("connection_reset");
    expect(JSON.stringify(redacted)).not.toContain("carol@example.com");
  });
});
