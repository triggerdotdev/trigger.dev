import { describe, expect, it, vi } from "vitest";
import {
  createBuildLogRenderer,
  resolveBuildLogsMode,
  streamDeploymentEvents,
  type BuildLogEntry,
} from "./buildLogs.js";

function fakeSpinner(calls: string[] = []) {
  return {
    calls,
    start: (m?: string) => void calls.push(`start:${m}`),
    message: (m?: string) => void calls.push(`message:${m}`),
    stop: (m?: string, code?: number) => void calls.push(`stop:${m}:${code}`),
  };
}

const entry = (message: string, level: BuildLogEntry["level"] = "info"): BuildLogEntry => ({
  timestamp: new Date("2026-08-28T10:00:00.000Z"),
  level,
  message,
});

describe("resolveBuildLogsMode", () => {
  it("honors the request in an interactive terminal", () => {
    const tty = { plain: false, ci: false, tty: true, windows: false };
    expect(resolveBuildLogsMode("compact", tty)).toBe("compact");
    expect(resolveBuildLogsMode("full", tty)).toBe("full");
  });

  it("forces full output for CI, --plain and piped output", () => {
    const tty = { plain: false, ci: false, tty: true, windows: false };
    expect(resolveBuildLogsMode("compact", { ...tty, ci: true })).toBe("full");
    expect(resolveBuildLogsMode("compact", { ...tty, plain: true })).toBe("full");
    expect(resolveBuildLogsMode("compact", { ...tty, tty: false })).toBe("full");
    expect(resolveBuildLogsMode("compact", { ...tty, windows: true })).toBe("full");
  });
});

describe("createBuildLogRenderer compact", () => {
  it("keeps one updating spinner line and stops it on success", () => {
    const s = fakeSpinner();
    const print = vi.fn();
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "Building version 1",
      spinner: s,
      print,
      columns: 200,
    });
    expect(r.started).toBe(false);
    r.log(entry("Installing dependencies"));
    r.log(entry("Building image"));
    expect(r.started).toBe(true);
    r.finish("Deployment completed successfully", "success");
    expect(s.calls).toEqual([
      "start:Build queued",
      "message:Building version 1: Installing dependencies",
      "message:Building version 1: Building image",
      "stop:Deployment completed successfully:undefined",
    ]);
    expect(print).not.toHaveBeenCalled();
  });

  it("prints only the last N lines when the build fails", () => {
    const s = fakeSpinner();
    const print = vi.fn();
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "t",
      spinner: s,
      print,
      tailSize: 3,
      columns: 200,
    });
    for (let i = 1; i <= 5; i++) r.log(entry(`line ${i}`, i === 5 ? "error" : "info"));
    r.finish("Deployment failed", "failure");
    expect(s.calls.at(-1)).toBe("stop:Deployment failed:2");
    const printed = print.mock.calls.map((c) => String(c[0]));
    expect(printed[1]).toContain("Last 3 lines of the build log");
    expect(
      printed
        .filter((l) => /line \d/.test(l))
        .map((l) =>
          l
            .replace(/\u001b\[[0-9;]*m/g, "")
            .split("  ")
            .at(-1)
        )
    ).toEqual(["line 3", "line 4", "line 5"]);
  });

  it("collapses multi-line messages and truncates to the terminal width", () => {
    const s = fakeSpinner();
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "Building version 1",
      spinner: s,
      print: vi.fn(),
      columns: 60,
    });
    r.log(entry("first line\n   second line " + "x".repeat(100)));
    const msg = s.calls.at(-1)!;
    expect(msg).toContain("Building version 1: first line second line");
    expect(msg.endsWith("…")).toBe(true);
    expect(msg.length).toBeLessThanOrEqual("message:".length + 60);
  });

  it("does not update the spinner for separator-only messages", () => {
    const s = fakeSpinner();
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "t",
      spinner: s,
      print: vi.fn(),
      columns: 200,
    });
    r.log(entry("------------------------------"));
    r.log(entry("   "));
    r.log(entry("real progress"));
    expect(s.calls).toEqual(["start:Build queued", "message:t: real progress"]);
  });

  it("stops the queued spinner without a tail when nothing was logged", () => {
    const s = fakeSpinner();
    const print = vi.fn();
    const r = createBuildLogRenderer({ mode: "compact", title: "t", spinner: s, print });
    r.finish("Log stream stopped", "failure");
    expect(s.calls).toEqual(["start:Build queued", "stop:Log stream stopped:2"]);
    expect(print).not.toHaveBeenCalled();
  });
});

describe("createBuildLogRenderer compact extras", () => {
  it("prints the tail after the spinner stops, in order", () => {
    const calls: string[] = [];
    const s = fakeSpinner(calls);
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "t",
      spinner: s,
      print: (l) => void calls.push(`print:${l.replace(/\u001b\[[0-9;]*m/g, "")}`),
      columns: 200,
    });
    r.log(entry("a"));
    r.finish("Deployment failed", "failure");
    expect(calls[0]).toBe("start:Build queued");
    expect(calls[1]).toBe("message:t: a");
    expect(calls[2]).toBe("stop:Deployment failed:2");
    expect(calls[3]).toBe("print:│");
    expect(calls[4]).toContain("Last 1 line of the build log");
    expect(calls[5]).toMatch(/  a$/);
  });

  it("strips ANSI codes before fitting the spinner line", () => {
    const s = fakeSpinner();
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "t",
      spinner: s,
      print: vi.fn(),
      columns: 200,
    });
    r.log(entry("\u001b[32mgreen\u001b[0m and \u001b[1mbold\u001b[0m"));
    expect(s.calls.at(-1)).toBe("message:t: green and bold");
  });

  it("stops without a tail when the stream was abandoned", () => {
    const s = fakeSpinner();
    const print = vi.fn();
    const r = createBuildLogRenderer({
      mode: "compact",
      title: "t",
      spinner: s,
      print,
      columns: 200,
    });
    r.log(entry("a", "error"));
    r.finish("Failed to query build progress", "abandoned");
    expect(s.calls.at(-1)).toBe("stop:Failed to query build progress:undefined");
    expect(print).not.toHaveBeenCalled();
  });
});

describe("createBuildLogRenderer full", () => {
  it("stops the queued spinner with the outcome when nothing was logged", () => {
    const s = fakeSpinner();
    const r = createBuildLogRenderer({
      mode: "full",
      title: "t",
      spinner: s,
      print: vi.fn(),
      success: vi.fn(),
    });
    r.finish("Log stream stopped", "failure");
    expect(s.calls).toEqual(["start:Build queued", "stop:Log stream stopped:2"]);
  });

  it("prints every line after stopping the queued spinner", () => {
    const s = fakeSpinner();
    const print = vi.fn();
    const success = vi.fn();
    const r = createBuildLogRenderer({ mode: "full", title: "t", spinner: s, print, success });
    r.log(entry("one"));
    r.log(entry("two", "warn"));
    r.finish("Deployment completed successfully", "success");
    expect(s.calls).toEqual(["start:Build queued", "stop:Build started:undefined"]);
    const printed = print.mock.calls.map((c) => String(c[0]).replace(/\u001b\[[0-9;]*m/g, ""));
    expect(printed[0]).toBe("│");
    expect(printed[1]).toMatch(/^│  \d\d:\d\d:\d\d\.\d{3}  one$/);
    expect(printed[2]).toMatch(/two$/);
    expect(success).toHaveBeenCalledWith("Deployment completed successfully");
  });

  it("leaves the failure message to the caller once lines were printed", () => {
    const s = fakeSpinner();
    const print = vi.fn();
    const r = createBuildLogRenderer({
      mode: "full",
      title: "t",
      spinner: s,
      print,
      success: vi.fn(),
    });
    r.log(entry("one"));
    r.finish("Deployment failed", "failure");
    expect(s.calls).toEqual(["start:Build queued", "stop:Build started:undefined"]);
    expect(print).toHaveBeenCalledTimes(2);
  });
});

describe("streamDeploymentEvents", () => {
  async function* records(bodies: string[]) {
    let seq = 0;
    for (const body of bodies) yield { seqNum: seq++, timestamp: 1_700_000_000_000, body };
  }

  it("forwards logs, skips garbage and returns the finalized event", async () => {
    const logged: string[] = [];
    const onFinalized = vi.fn();
    const renderer = {
      started: false,
      log: (e: BuildLogEntry) => void logged.push(`${e.level}:${e.message}`),
      finish: vi.fn(),
    };
    const final = await streamDeploymentEvents(
      records([
        JSON.stringify({ type: "log", data: { message: "a" } }),
        "not json",
        JSON.stringify({ type: "log", data: { level: "error", message: "b" } }),
        JSON.stringify({ type: "finalized", data: { result: "failed", message: "boom" } }),
      ]),
      renderer,
      onFinalized
    );
    expect(logged).toEqual(["info:a", "error:b"]);
    expect(final).toEqual({ result: "failed", message: "boom" });
    expect(onFinalized).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when the stream ends without a finalized event", async () => {
    const final = await streamDeploymentEvents(
      records([JSON.stringify({ type: "log", data: { message: "a" } })]),
      { started: false, log: vi.fn(), finish: vi.fn() },
      vi.fn()
    );
    expect(final).toBeUndefined();
  });
});
