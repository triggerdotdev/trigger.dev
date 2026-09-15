import { describe, expect, it } from "vitest";
import {
  capEvalToolActivity,
  extractToolActivity,
  MAX_EVAL_ACTIVITY_CHARS,
  MAX_EVAL_TOOL_INPUT_CHARS,
  truncateEvalToolValue,
  unfoldEvalToolOutput,
} from "./dashboard-agent";
import { allowedEvalKeys, evalOutputErrored, redactEvalToolValue } from "./eval-policy";
import { toolResultErrored } from "./eval-turn";

type Messages = Parameters<typeof extractToolActivity>[0];

function turn(toolName: string, input: unknown, output: unknown, toolCallId = "tc1"): Messages {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output }] },
  ] as unknown as Messages;
}

describe("the eval judge's structural allow-list", () => {
  it("withholds a free-text field it has never heard of", () => {
    const redacted = redactEvalToolValue({
      id: "run_1",
      status: "FAILED",
      customerNote: "card ending 4242 declined for alice@example.com",
    }) as Record<string, unknown>;

    expect(redacted.id).toBe("run_1");
    expect(redacted.status).toBe("FAILED");
    expect(redacted.customerNote).toMatchObject({ redacted: "customerNote" });
    expect(JSON.stringify(redacted)).not.toContain("alice@example.com");
  });

  it("withholds message, errorMessage, commitMessage and span attributes", () => {
    const redacted = redactEvalToolValue({
      message: "order 42 for alice@example.com failed",
      errorMessage: "row {id: 7, email: alice@example.com} rejected",
      commitMessage: "fix billing for Acme Corp",
      spans: [{ attributes: { "user.email": "alice@example.com" } }],
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("Acme Corp");
    expect(redacted).toMatchObject({
      message: { redacted: "message" },
      errorMessage: { redacted: "errorMessage" },
      commitMessage: { redacted: "commitMessage" },
      spans: { redacted: "spans" },
    });
  });

  it("withholds a redacted object's key names, not only its values", () => {
    const redacted = redactEvalToolValue({
      id: "run_1",
      payload: { "billing@customer.com": { plan: "pro" }, "Acme Corp": 1 },
    }) as Record<string, unknown>;

    expect(redacted.payload).toEqual({ redacted: "payload", keyCount: 2 });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("billing@customer.com");
    expect(serialized).not.toContain("Acme Corp");
  });

  it("withholds the key names of an object sitting at the depth cap", () => {
    // Eight allowed containers puts the object exactly on MAX_REDACT_DEPTH, where the walk stops.
    let value: unknown = { "billing@customer.com": 1, "Acme Corp": 2 };
    for (let depth = 0; depth < 8; depth++) value = { data: value };

    const serialized = JSON.stringify(redactEvalToolValue(value));
    expect(serialized).toContain('"truncated":true');
    expect(serialized).not.toContain("billing@customer.com");
    expect(serialized).not.toContain("Acme Corp");
  });

  it("redacts a tool's own `keys` field like any other unknown name", () => {
    expect(allowedEvalKeys().has("keys")).toBe(false);

    const redacted = redactEvalToolValue({ keys: ["billing@customer.com"] }) as Record<
      string,
      unknown
    >;
    expect(redacted.keys).toEqual({ redacted: "keys", items: 1 });
    expect(JSON.stringify(redacted)).not.toContain("billing@customer.com");
  });

  it("allows a tool's own structural fields, and only for that tool", () => {
    expect(allowedEvalKeys("run_query").has("columns")).toBe(true);
    expect(allowedEvalKeys("get_run").has("columns")).toBe(false);

    const forQuery = redactEvalToolValue({ columns: ["status", "count"] }, "run_query");
    expect(forQuery).toEqual({ columns: ["status", "count"] });

    const forRun = redactEvalToolValue({ columns: ["status", "count"] }, "get_run");
    expect(forRun).toEqual({ columns: { redacted: "columns", items: 2 } });
  });
});

describe("the eval judge payload's size", () => {
  it("truncates a tool input, not only a tool output", () => {
    // Allowed fields, so nothing is redacted away — the size alone has to be handled.
    const ids = Array.from({ length: 400 }, (_, i) => `run_${i}`);
    const activity = extractToolActivity(turn("get_run", { ids }, { type: "json", value: {} }));

    const input = JSON.stringify(activity[0]!.input);
    expect(input.length).toBeLessThan(MAX_EVAL_TOOL_INPUT_CHARS + 400);
    expect(activity[0]!.input).toMatchObject({ truncated: true });
  });

  it("truncates any value at the limit it is given", () => {
    const small = { id: "run_1" };
    expect(truncateEvalToolValue(small, 100)).toBe(small);
    expect(truncateEvalToolValue(undefined, 100)).toBeUndefined();
    expect(truncateEvalToolValue({ note: "y".repeat(500) }, 50)).toMatchObject({
      truncated: true,
    });
  });

  it("caps the whole turn, keeping the name of every call it drops", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      toolName: `tool_${i}`,
      output: { note: "z".repeat(1_400) },
    }));

    const capped = capEvalToolActivity(entries) as Array<Record<string, unknown>>;
    expect(capped).toHaveLength(40);
    expect(JSON.stringify(capped).length).toBeLessThan(MAX_EVAL_ACTIVITY_CHARS + 2_000);
    expect(capped.at(-1)).toEqual({ toolName: "tool_39", omitted: true });
    // Every call is still named, so `toolsUsed` on the row stays complete.
    expect(capped.map((entry) => entry.toolName)).toEqual(entries.map((entry) => entry.toolName));
  });

  it("caps a nine-step turn below the aggregate limit", () => {
    const messages: Messages = [];
    for (let step = 0; step < 9; step++) {
      messages.push(
        ...turn(
          "get_run_trace",
          { runId: `run_${step}` },
          {
            type: "json",
            value: {
              spans: Array.from({ length: 200 }, () => ({ attributes: { body: "q".repeat(50) } })),
            },
          },
          `tc${step}`
        )
      );
    }

    const activity = extractToolActivity(messages);
    expect(activity).toHaveLength(9);
    expect(JSON.stringify(activity).length).toBeLessThanOrEqual(MAX_EVAL_ACTIVITY_CHARS);
  });
});

describe("an errored tool result", () => {
  it("unfolds error-text so its message is redacted, not carried whole", () => {
    const unfolded = unfoldEvalToolOutput({
      type: "error-text",
      value: "query failed on row {email: alice@example.com}",
    });
    expect(unfolded).toMatchObject({ isError: true, error: { type: "error-text" } });

    const redacted = redactEvalToolValue(unfolded) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain("alice@example.com");
    expect(redacted.error).toEqual({ type: "error-text" });
  });

  it("still reads as an error after redaction", () => {
    const activity = extractToolActivity(
      turn(
        "run_query",
        { runId: "run_1" },
        {
          type: "error-text",
          value: "boom on alice@example.com",
        }
      )
    );

    expect(JSON.stringify(activity)).not.toContain("alice@example.com");
    expect(toolResultErrored(activity[0]!.output)).toBe(true);
  });

  it("reads a tool's own error message as an error too", () => {
    expect(evalOutputErrored({ error: "Couldn't get run run_1 (status 500)." })).toBe(true);
    // The subject's failure, not the call's: a run that failed was still retrieved.
    expect(evalOutputErrored({ error: { name: "TimeoutError" } })).toBe(false);
    expect(evalOutputErrored({ id: "run_1" })).toBe(false);
    expect(evalOutputErrored("boom")).toBe(false);
  });

  it("reads the derived category once the message is gone", () => {
    expect(toolResultErrored({ errorCategory: "timeout", error: { redacted: "error" } })).toBe(
      true
    );
    expect(toolResultErrored({ error: { name: "TimeoutError" } })).toBe(false);
    expect(toolResultErrored({ id: "run_1" })).toBe(false);
    expect(toolResultErrored("boom")).toBe(false);
  });

  it("unfolds a successful json result to its value", () => {
    expect(unfoldEvalToolOutput({ type: "json", value: { id: "run_1" } })).toEqual({
      id: "run_1",
    });
    expect(unfoldEvalToolOutput({ id: "run_1" })).toEqual({ id: "run_1" });
  });
});
