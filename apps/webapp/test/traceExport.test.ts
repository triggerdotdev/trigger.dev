import { describe, expect, it } from "vitest";
import {
  getTraceExportFormat,
  streamTraceExport,
  type TraceExportContext,
} from "~/v3/eventRepository/traceExport.server";
import type { StreamedTraceEvent } from "~/v3/eventRepository/eventRepository.types";

const T = new Date("2026-06-06T12:00:00.000Z");

const CTX: TraceExportContext = {
  runFriendlyId: "run_x",
  traceId: "trace_x",
  taskIdentifier: "agent-workflow",
  runUrl: "https://app.example.com/orgs/o/projects/p/env/dev/runs/run_x",
};

function sampleEvents(): StreamedTraceEvent[] {
  return [
    {
      spanId: "root1",
      parentSpanId: "",
      startTime: T,
      durationNs: 5_500_000_000, // 5.5s
      level: "TRACE",
      message: "agent.run",
      isError: false,
      propertiesText: '{"agent":{"name":"researcher-v2"}}',
    },
    {
      spanId: "log1",
      parentSpanId: "root1",
      startTime: T,
      durationNs: 0,
      level: "INFO",
      message: "processing item",
      isError: false,
      propertiesText: '{"itemId":7}',
    },
    {
      spanId: "err1",
      parentSpanId: "root1",
      startTime: T,
      durationNs: 3_000_000, // 3ms
      level: "ERROR",
      message: "task failed",
      isError: true,
      propertiesText:
        '{"error":{"message":"boom: it failed","name":"Error","stackTrace":"Error: boom\\n    at fn"}}',
    },
    {
      spanId: "quiet1",
      parentSpanId: "root1",
      startTime: T,
      durationNs: 0,
      level: "DEBUG",
      message: "no props here",
      isError: false,
      propertiesText: "{}",
    },
  ];
}

async function* toAsyncIterable(items: StreamedTraceEvent[]): AsyncIterable<StreamedTraceEvent> {
  for (const item of items) {
    yield item;
  }
}

async function drain(gen: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of gen) {
    text += chunk;
  }
  return text;
}

function render(formatName: string, items = sampleEvents(), opts = {}): Promise<string> {
  return drain(
    streamTraceExport(toAsyncIterable(items), getTraceExportFormat(formatName), CTX, opts)
  );
}

describe("getTraceExportFormat", () => {
  it("resolves known formats and defaults unknown ones to log", () => {
    expect(getTraceExportFormat("log").extension).toBe("txt");
    expect(getTraceExportFormat("jsonl").extension).toBe("jsonl");
    expect(getTraceExportFormat("markdown").extension).toBe("md");
    expect(getTraceExportFormat(null).name).toBe("log");
    expect(getTraceExportFormat("bogus").name).toBe("log");
  });
});

describe("log format", () => {
  it("is flat events with parent refs, no header, ns durations, inline error message", async () => {
    const text = await render("log");
    expect(text).not.toContain("Run:");
    expect(text).not.toContain("Trace ID:");
    expect(text.startsWith("2026-")).toBe(true);
    expect(text).toContain("[root1] agent.run");
    expect(text).toContain("(5.5 seconds)");
    expect(text).not.toMatch(/day/);
    expect(text).toContain("[log1 ← root1] processing item");
    expect(text).toContain('props: {"itemId":7}');
    // Error message surfaced inline (not just an [ERROR] flag).
    expect(text).toContain("[err1 ← root1] task failed [ERROR: boom: it failed]");
    // Empty properties are omitted.
    expect(text).not.toContain("props: {}");
  });
});

describe("jsonl format", () => {
  it("emits one valid JSON object per line with inlined properties + errorMessage", async () => {
    const text = await render("jsonl");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(4);

    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      spanId: "root1",
      message: "agent.run",
      level: "TRACE",
      durationNs: 5_500_000_000,
    });
    expect(first.parentSpanId).toBeUndefined();
    expect(first.properties).toEqual({ agent: { name: "researcher-v2" } });

    const err = JSON.parse(lines[2]);
    expect(err.isError).toBe(true);
    expect(err.errorMessage).toBe("boom: it failed");
    expect(err.properties.error.stackTrace).toContain("at fn");

    const quiet = JSON.parse(lines[3]);
    expect(quiet.properties).toBeUndefined(); // "{}" → omitted
    expect(quiet.errorMessage).toBeUndefined();
  });
});

describe("markdown format", () => {
  it("emits YAML frontmatter with ids/task/url and a table (no fenced blocks)", async () => {
    const text = await render("markdown");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("run: run_x");
    expect(text).toContain("trace: trace_x");
    expect(text).toContain("task: agent-workflow");
    expect(text).toContain("url: https://app.example.com/orgs/o/projects/p/env/dev/runs/run_x");
    expect(text).toContain("# Trace for run_x");
    expect(text).toContain(
      "[View in dashboard](https://app.example.com/orgs/o/projects/p/env/dev/runs/run_x)"
    );
    expect(text).toContain("| time | level | event | duration | span ← parent | properties |");
    expect(text).not.toContain("```json");
    expect(text).toContain("`log1 ← root1`");
    expect(text).toContain("ERROR ❌");
    // Error message surfaced in the event cell.
    expect(text).toContain("| task failed — boom: it failed |");
  });
});

describe("all formats", () => {
  it("produce identical output regardless of flush size (no cross-event state)", async () => {
    for (const name of ["log", "jsonl", "markdown"]) {
      const full = await render(name);
      const tiny = await render(name, sampleEvents(), { flushBytes: 8 });
      expect(tiny, `format ${name}`).toEqual(full);
    }
  });
});
