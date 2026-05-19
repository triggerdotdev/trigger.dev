import { describe, it, expect } from "vitest";
import { emit, EmitMessage } from "./emit.js";
import { newState } from "./new.js";

function captureEmit(state: Parameters<typeof emit>[0]): Record<string, unknown> {
  const captured: string[] = [];
  const origWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    emit(state);
  } finally {
    process.stdout.write = origWrite;
  }
  expect(captured).toHaveLength(1);
  const line = captured[0];
  if (!line) throw new Error("no captured line");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("emit", () => {
  it("emits a single line with the stable message + request_id", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.statusCode = 200;
    s.ok = true;
    s.durationMs = 5;
    const out = captureEmit(s);
    expect(out.msg).toBe(EmitMessage);
    expect(out.request_id).toBe(s.requestId);
    expect(out.service).toBe("supervisor");
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.duration_ms).toBe(5);
  });

  it("omits empty optional fields", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.statusCode = 200;
    s.ok = true;
    const out = captureEmit(s);
    expect(out).not.toHaveProperty("trace_id");
    expect(out).not.toHaveProperty("version");
    expect(out).not.toHaveProperty("commit_sha");
    expect(out).not.toHaveProperty("error.code");
  });

  it("flattens meta keys as meta.<key>", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.statusCode = 200;
    s.ok = true;
    s.meta.run_id = "run_abc";
    s.meta.deployment_id = "dep_xyz";
    const out = captureEmit(s);
    expect(out["meta.run_id"]).toBe("run_abc");
    expect(out["meta.deployment_id"]).toBe("dep_xyz");
    expect(out).not.toHaveProperty("meta");
  });

  it("flattens phases as phase.<name>.<field>", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.statusCode = 200;
    s.ok = true;
    s.phases.push({ name: "warm_start", durationMs: 12, ok: true, attempts: 1 });
    s.phases.push({
      name: "workload_create",
      durationMs: 3,
      ok: false,
      attempts: 2,
      errorCode: "Error",
      errorMsg: "boom",
      sub: { create_ms: 1 },
    });
    const out = captureEmit(s);
    expect(out["phase.warm_start.duration_ms"]).toBe(12);
    expect(out["phase.warm_start.ok"]).toBe(true);
    expect(out["phase.warm_start.attempts"]).toBe(1);
    expect(out["phase.workload_create.duration_ms"]).toBe(3);
    expect(out["phase.workload_create.ok"]).toBe(false);
    expect(out["phase.workload_create.attempts"]).toBe(2);
    expect(out["phase.workload_create.error_code"]).toBe("Error");
    expect(out["phase.workload_create.error_message"]).toBe("boom");
    expect(out["phase.workload_create.create_ms"]).toBe(1);
  });

  it("includes error.code/message/kind when state.error is set", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.statusCode = 500;
    s.error = { code: "InternalError", message: "kaboom", kind: "internal" };
    const out = captureEmit(s);
    expect(out["error.code"]).toBe("InternalError");
    expect(out["error.message"]).toBe("kaboom");
    expect(out["error.kind"]).toBe("internal");
  });

  it("truncates very long error messages", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.error = { code: "Big", message: "x".repeat(2000), kind: "internal" };
    const out = captureEmit(s);
    expect((out["error.message"] as string).length).toBe(512);
  });

  it("flattens extras at the top level", () => {
    const s = newState({ service: "supervisor", env: {} });
    s.statusCode = 200;
    s.ok = true;
    s.extras.route = "/health";
    s.extras["dispatch.result"] = "hit";
    const out = captureEmit(s);
    expect(out.route).toBe("/health");
    expect(out["dispatch.result"]).toBe("hit");
  });
});
