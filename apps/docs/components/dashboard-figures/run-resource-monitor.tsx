// The run page with one of the ResourceMonitor logs from the machines page selected: the trace of
// logs on the left and the log inspector (timestamp, message, properties) on the right. The ffmpeg
// variant adds the child process's CPU and memory. Drawn from source and the old screenshots; the
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { RunPageBody } from "./run-page";
import {
  CodeBlock,
  MessageProperty,
  RunHeader,
  RunTimeline,
  SpanInspector,
  type TraceRow,
} from "./run-parts";

// [system mem, node mem, heap, ffmpeg cpu, ffmpeg mem, gc count, gc avg ms], one per second.
const samples = [
  [35.9, 8.2, 3.1, 96.0, 11.4, 4, 2.2],
  [36.3, 9.1, 3.9, 96.6, 28.0, 7, 1.6],
  [36.5, 9.7, 4.7, 96.8, 33.9, 4, 1.4],
  [36.4, 10.5, 5.8, 96.2, 39.7, 6, 2.0],
  [36.4, 11.0, 6.5, 96.1, 43.0, 4, 2.7],
  [36.1, 11.7, 7.3, 95.8, 46.1, 4, 1.9],
  [36.2, 12.3, 8.1, 95.7, 48.6, 4, 2.6],
  [36.3, 14.9, 8.8, 95.4, 49.9, 8, 1.6],
  [36.1, 14.5, 9.6, 95.6, 51.0, 4, 1.9],
  [36.6, 15.2, 10.4, 94.8, 52.7, 6, 1.5],
];
const SELECTED = 5;

const pct = (n: number, width: number) => n.toFixed(1).padStart(width);
const ok = (n: number, warn: number, crit: number) =>
  n >= crit ? " [CRIT]" : n >= warn ? " [WARN]" : " [OK]";

/** The docs' ResourceMonitor createEnhancedLabel, for one sample. */
function label([mem, node, heap, cpu, procMem, gcCount, gcAvg]: number[], ffmpeg: boolean) {
  return [
    "ResourceMonitor",
    `Disk:${pct(0, 5)}%${ok(0, 80, 90)}`,
    `Mem:${pct(mem, 5)}%${ok(mem, 80, 90)}`,
    `Node:${pct(node, 4)}%${ok(node, 70, 85)}`,
    `Heap:${pct(heap, 4)}%${ok(heap, 70, 85)}`,
    ...(ffmpeg
      ? [`ffmpeg:${pct(cpu, 4)}%${ok(cpu, 80, 90)}/${pct(procMem, 4)}%${ok(procMem, 80, 90)}`]
      : []),
    `GC:${String(gcCount).padStart(2)}(${pct(gcAvg, 4)}ms)${ok(gcAvg, 5, 10)}`,
    "[1CPU/1GB]",
  ].join(" | ");
}

function properties([mem, node, heap, cpu, procMem, gcCount, gcAvg]: number[], ffmpeg: boolean) {
  return {
    gc: {
      count: gcCount,
      avgDuration: gcAvg,
      maxDuration: 2.31,
      totalDuration: +(gcCount * gcAvg).toFixed(2),
    },
    timestamp: "2026-11-25T10:42:13.567Z",
    constraints: { cpu: 1, memoryGB: 1, diskGB: 10 },
    system: {
      disk: {
        limitGiB: 10,
        dirName: "/tmp",
        usedGiB: "0.00",
        freeGiB: "10.00",
        percentUsed: "0.0",
      },
      memory: { freeGB: "0.63", percentUsed: mem.toFixed(1) },
    },
    process: {
      node: {
        memoryUsageMB: (node * 10.24).toFixed(2),
        memoryUsagePercent: node.toFixed(1),
        heapUsedMB: (heap * 8.31).toFixed(2),
        heapSizeLimitMB: "831.00",
        heapUsagePercent: heap.toFixed(1),
      },
      targetProcess: ffmpeg
        ? {
            method: "proc",
            processName: "ffmpeg",
            count: 2,
            totals: { cpuPercent: cpu.toFixed(1), memoryPercent: procMem.toFixed(1) },
          }
        : null,
    },
  };
}

function rows(ffmpeg: boolean): TraceRow[] {
  return [
    {
      kind: "task",
      label: "resource-monitor-test",
      depth: 0,
      open: true,
      root: true,
      status: "completed",
      start: 0,
      duration: 181200,
    },
    {
      kind: "attempt",
      label: "Attempt 1",
      depth: 1,
      open: true,
      status: "cold",
      start: 420,
      duration: 180700,
      events: [10, 300],
    },
    { kind: "function", label: "run()", depth: 2, open: true, start: 430, duration: 180650 },
    ...samples.map((s, i) => ({
      kind: "log" as const,
      label: label(s, ffmpeg),
      depth: 3,
      selected: i === SELECTED,
      start: 1430 + i * 1000,
    })),
  ];
}

function ResourceMonitorRun({ ffmpeg }: { ffmpeg: boolean }) {
  const sample = samples[SELECTED];
  const message = label(sample, ffmpeg);
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunHeader runId="run_cmie6d2w4000307l4k9t3xq7m" />
      <RunPageBody
        trace={rows(ffmpeg)}
        total={181200}
        inspector={
          <SpanInspector kind="log" title={message}>
            <RunTimeline
              items={[{ event: "Timestamp", date: "25 Nov 10:42:13.567 am", marker: "dot-solid" }]}
            />
            <MessageProperty message={message} />
            <CodeBlock title="Properties" value={properties(sample, ffmpeg)} />
          </SpanInspector>
        }
      />
    </div>
  );
}

export function RunResourceMonitorFigure() {
  return <ResourceMonitorRun ffmpeg={false} />;
}

export function RunResourceMonitorFfmpegFigure() {
  return <ResourceMonitorRun ffmpeg />;
}
