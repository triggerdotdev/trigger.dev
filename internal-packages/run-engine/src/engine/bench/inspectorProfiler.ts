/**
 * In-process CPU profiler and event-loop-utilization sampler.
 *
 * The webapp bench profiles a spawned child over CDP, but this bench drives the
 * engine directly, so the code under measurement and the driver share a
 * process. `node:inspector`'s Session profiles that process in place.
 *
 * The driver's own cost lands in the profile too. That is acceptable and
 * visible: the driver is a thin await loop, and it shows up under its own
 * frames in the ranked output rather than being smeared across engine frames.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const IDLE_FRAMES = new Set(["(idle)", "(program)"]);

type ProfileShape = {
  nodes: Array<{ id: number; callFrame: { functionName: string } }>;
  samples?: number[];
  timeDeltas?: number[];
};

function onCpuMicros(profile: ProfileShape): number {
  const idleNodeIds = new Set(
    profile.nodes
      .filter((node) => IDLE_FRAMES.has(node.callFrame.functionName))
      .map((node) => node.id)
  );

  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];

  let micros = 0;
  for (let i = 0; i < samples.length; i++) {
    const delta = timeDeltas[i] ?? 0;
    if (delta > 0 && !idleNodeIds.has(samples[i]!)) micros += delta;
  }
  return micros;
}

export type EluStats = {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  sampleCount: number;
};

export class InProcessProfiler {
  private session: Session | null = null;
  private eluTimer: NodeJS.Timeout | null = null;
  private eluSamples: number[] = [];
  private lastElu: ReturnType<typeof performance.eventLoopUtilization> | null = null;

  /**
   * `intervalUs` is V8's sampling interval in microseconds, 5x finer than
   * V8's own 1ms default so short engine operations land enough samples to
   * separate the frames inside them.
   */
  async startCpuProfile(intervalUs = 200): Promise<void> {
    const session = new Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: intervalUs });
    await session.post("Profiler.start");
    this.session = session;
  }

  /**
   * `onCpuMs` excludes V8's `(idle)` and `(program)` frames, so it is the time
   * the phase actually held the event loop rather than the wall clock it
   * spanned. That is the number a change has to move.
   */
  async stopCpuProfile(
    outPath: string
  ): Promise<{ path: string; sampleCount: number; onCpuMs: number }> {
    if (!this.session) throw new Error("startCpuProfile was never called");

    const { profile } = await this.session.post("Profiler.stop");
    this.session.disconnect();
    this.session = null;

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(profile));

    return {
      path: outPath,
      sampleCount: profile.samples?.length ?? 0,
      onCpuMs: onCpuMicros(profile) / 1000,
    };
  }

  startEluSampling(intervalMs = 250): void {
    this.eluSamples = [];
    this.lastElu = performance.eventLoopUtilization();

    const timer = setInterval(() => {
      const current = performance.eventLoopUtilization();
      const diff = performance.eventLoopUtilization(current, this.lastElu!);
      this.lastElu = current;
      this.eluSamples.push(Number.isFinite(diff.utilization) ? diff.utilization : 0);
    }, intervalMs);

    timer.unref();
    this.eluTimer = timer;
  }

  stopEluSampling(): EluStats {
    if (this.eluTimer) {
      clearInterval(this.eluTimer);
      this.eluTimer = null;
    }

    if (this.eluSamples.length === 0) {
      return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, sampleCount: 0 };
    }

    const sorted = [...this.eluSamples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;

    return {
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted[sorted.length - 1]!,
      sampleCount: sorted.length,
    };
  }
}
