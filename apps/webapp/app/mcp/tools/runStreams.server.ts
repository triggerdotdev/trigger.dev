import { $replica } from "~/db.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import type { StreamRecord } from "~/services/realtime/types";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { runStore } from "~/v3/runStore.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { untrusted } from "./format/logFields";
import { ReadRunStreamInput } from "./schemas/runStreams";

const POLL_INTERVAL_MS = 750;
const READ_ALLOWANCE_MS = 10_000;
const RECORD_CHARS = 4_000;
const TOTAL_CHARS = 40_000;
const KEY_CHARS = 128;
const LISTED_KEYS = 100;
const PLAIN_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_PREFIX = "$trigger.";
const INPUT_PREFIX = "$trigger.input:";
const CHAT_INPUT_KEYS = new Set(["chat-messages", "chat-stop"]);
const FIRST_GENERATION =
  "This run uses the first-generation stream store, which the remote MCP server cannot read. Open the run in the dashboard to see its streams.";

const renderKey = (key: string) =>
  PLAIN_KEY.test(key) ? `"${key}"` : untrusted(key, "run-stream-key", KEY_CHARS);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function renderRecords(records: StreamRecord[]) {
  const lines: string[] = [];
  let used = 0;
  let truncated = 0;
  for (const record of records) {
    const data = typeof record.data === "string" ? record.data : JSON.stringify(record.data);
    const line = `#${record.seqNum} ${untrusted(data, "run-stream-record", RECORD_CHARS)}`;
    if (lines.length > 0 && used + line.length > TOTAL_CHARS) break;
    lines.push(line);
    used += line.length;
    if (data.length > RECORD_CHARS) truncated++;
  }
  return { lines, truncated };
}

const TIMED_OUT = "The stream did not answer in time. Try again.";

function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal
): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => resolve(undefined));
    const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

export function createRunStreamsTools({
  readAllowanceMs = READ_ALLOWANCE_MS,
}: { readAllowanceMs?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "read_run_stream",
      title: "Read Run Stream",
      description: `Read the records a run streamed (direction \`output\`) or that were sent to one of its input streams (direction \`input\`), like the streams on the run page in the dashboard. Omit \`key\` with \`output\` to list the run's output stream keys. Returns the records after the optional cursor and closes; set \`timeoutInSeconds\` to wait for a record when none exist yet. Each record is cut at ${RECORD_CHARS.toLocaleString("en-US")} characters and one call returns at most ${TOTAL_CHARS.toLocaleString("en-US")} characters of records. The run ID starts with run_`,
      shape: ReadRunStreamInput.shape,
      auth: { action: "read", subject: "runs" },
      run: async (input, ctx) => {
        if (input.direction === "input" && input.key === undefined) {
          return errorResult("Pass key to read an input stream");
        }
        if (input.key?.startsWith(RESERVED_PREFIX)) {
          return errorResult(`Stream keys starting with ${RESERVED_PREFIX} are reserved`);
        }
        if (input.direction === "input" && CHAT_INPUT_KEYS.has(input.key!)) {
          return errorResult(
            "Chat input streams can't be read through the MCP server; open the run in the dashboard."
          );
        }

        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Environment not found");

        const where = { friendlyId: input.runId, runtimeEnvironmentId: environment.id };
        const args = {
          select: { friendlyId: true, realtimeStreamsVersion: true, streamBasinName: true },
        };
        const run =
          (await runStore.findRun(where, args, $replica)) ??
          (await runStore.findRunOnPrimary(where, args));
        if (!run) return errorResult("Run not found");

        if (run.realtimeStreamsVersion === "v1") return errorResult(FIRST_GENERATION);
        const stream = getRealtimeStreamInstance(environment, run.realtimeStreamsVersion, { run });
        if (!(stream instanceof S2RealtimeStreams)) return errorResult(FIRST_GENERATION);

        const deadline = Date.now() + (input.timeoutInSeconds ?? 0) * 1000 + readAllowanceMs;
        const bounded = <T>(promise: Promise<T>) => withinDeadline(promise, deadline, ctx.signal);

        if (input.key === undefined) {
          const listed = await bounded(stream.listRunStreams(run.friendlyId));
          if (listed === undefined) return errorResult(TIMED_OUT);
          const keys = listed.filter((key) => !key.startsWith(RESERVED_PREFIX)).sort();
          if (keys.length === 0) return textResult(`Run ${run.friendlyId} has no output streams.`);
          const shown = keys.slice(0, LISTED_KEYS);
          return textResult(
            [
              `Run ${run.friendlyId} has ${plural(keys.length, "output stream")}:`,
              ...shown.map((key) => `- ${renderKey(key)}`),
              ...(keys.length > shown.length
                ? [`Showing the first ${LISTED_KEYS} keys in alphabetical order.`]
                : []),
            ].join("\n")
          );
        }

        const streamId = input.direction === "input" ? `${INPUT_PREFIX}${input.key}` : input.key;
        const drain = () =>
          bounded(
            stream.readRecords(run.friendlyId, streamId, input.afterEventId, input.maxRecords + 1)
          );

        let records = await drain();
        if (records === undefined) return errorResult(TIMED_OUT);
        if (records.length === 0 && input.timeoutInSeconds !== undefined) {
          const waitUntil = Date.now() + input.timeoutInSeconds * 1000;
          while (records.length === 0 && Date.now() < waitUntil) {
            const pause = Math.min(POLL_INTERVAL_MS, waitUntil - Date.now());
            const slept = await bounded(new Promise((resolve) => setTimeout(resolve, pause, true)));
            const next = slept === undefined ? undefined : await drain();
            if (next === undefined) {
              if (ctx.signal.aborted) break;
              return errorResult(TIMED_OUT);
            }
            records = next;
          }
        }

        const page = records.slice(0, input.maxRecords);
        const { lines, truncated } = renderRecords(page);
        const hasMore = records.length > lines.length;
        const cursor = records[lines.length - 1]?.seqNum;
        const header = `Run ${run.friendlyId} ${input.direction} stream ${renderKey(input.key)}: ${plural(lines.length, "record")}${hasMore ? " (more available)" : ""}`;

        const notes = [
          ...(truncated > 0
            ? [
                `${plural(truncated, "record")} cut at ${RECORD_CHARS.toLocaleString("en-US")} characters.`,
              ]
            : []),
          ...(lines.length < page.length
            ? [
                `Stopped at ${TOTAL_CHARS.toLocaleString("en-US")} characters of records; the rest were not returned.`,
              ]
            : []),
          ...(hasMore && cursor !== undefined
            ? [`More records available. Read again with afterEventId ${cursor} to continue.`]
            : []),
        ];

        return textResult([header, ...lines, ...notes].join("\n"));
      },
    }),
  ];
}

export const runStreamsTools: McpToolDefinition[] = createRunStreamsTools();
