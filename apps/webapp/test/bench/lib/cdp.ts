/**
 * Minimal Chrome DevTools Protocol client for benchmarking a spawned webapp.
 *
 * The bench spawns the webapp with `--inspect=<port>` and drives the V8 CPU
 * profiler over CDP rather than using `--cpu-prof`. Two reasons:
 *
 *  1. `--cpu-prof` only writes at process exit, so its profile covers boot,
 *     module init and shutdown as well as the load. Boot dominates a short run
 *     and buries the request-path frames this pass is about.
 *  2. Over CDP the profiler can be started and stopped around the measured
 *     window only, and several separately-named profiles can be taken from a
 *     single webapp instance.
 *
 * The same connection samples `performance.eventLoopUtilization()` inside the
 * target process, which is the number this pass is trying to move. Sampling it
 * from the bench process would only describe the load generator.
 */
import { writeFile } from "node:fs/promises";
import { WebSocket } from "ws";

type CdpMessage = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
};

export type EluSample = {
  /** ms since the sampler started */
  atMs: number;
  /** utilization over the interval since the previous sample, 0..1 */
  utilization: number;
};

export type EluStats = {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  sampleCount: number;
};

/**
 * Node prints the inspector ws URL to stderr on boot, but the bench does not
 * own the spawn, so discover it over the inspector's HTTP endpoint instead.
 */
async function discoverWebSocketUrl(port: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as Array<{ webSocketDebuggerUrl?: string }>;
      const url = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
      if (url) return url;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`No inspector target on port ${port} after ${timeoutMs}ms: ${lastError}`);
}

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  /**
   * Anything that ends the socket has to settle the in-flight requests. If the
   * profiled webapp exits mid-run, an unsettled `send()` would otherwise hang
   * until the suite-level timeout with nothing explaining why.
   */
  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on("message", (data) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(data.toString()) as CdpMessage;
      } catch {
        return;
      }
      if (msg.id === undefined) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiter.resolve(msg.result);
    });

    const rejectAll = (reason: string) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(reason));
      }
      this.pending.clear();
    };

    this.ws.on("error", (err: Error) => rejectAll(`CDP socket error: ${err.message}`));
    this.ws.on("close", () => rejectAll("CDP socket closed before the response arrived"));
  }

  /**
   * A full CPU profile of a busy minute is tens of MB and arrives as a single
   * ws frame, so the payload cap is raised well past the 100MB default.
   */
  static async connect(inspectPort: number): Promise<CdpSession> {
    const url = await discoverWebSocketUrl(inspectPort);
    const ws = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new CdpSession(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open, cannot send ${method}`));
    }

    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close(): void {
    this.ws.close();
  }
}

export class WebappProfiler {
  private session: CdpSession;
  private eluTimer: NodeJS.Timeout | null = null;
  private eluSamples: EluSample[] = [];
  private eluStartedAt = 0;

  private constructor(session: CdpSession) {
    this.session = session;
  }

  static async attach(inspectPort: number): Promise<WebappProfiler> {
    const session = await CdpSession.connect(inspectPort);
    await session.send("Runtime.enable");
    await session.send("Profiler.enable");
    return new WebappProfiler(session);
  }

  /**
   * `intervalUs` is V8's sampling interval in microseconds. The 200us default is
   * 5x finer than V8's own 1ms: the engine routes are short, and at 1ms too few
   * samples land inside a single request to separate the frames within it.
   */
  async startCpuProfile(intervalUs = 200): Promise<void> {
    await this.session.send("Profiler.setSamplingInterval", { interval: intervalUs });
    await this.session.send("Profiler.start");
  }

  async stopCpuProfile(outPath: string): Promise<{ path: string; sampleCount: number }> {
    const { profile } = await this.session.send<{ profile: { samples?: number[] } }>(
      "Profiler.stop"
    );
    await writeFile(outPath, JSON.stringify(profile));
    return { path: outPath, sampleCount: profile.samples?.length ?? 0 };
  }

  /**
   * The first evaluate seeds a baseline reading so that the first recorded
   * delta is measured from the moment sampling started rather than from
   * process boot.
   */
  startEluSampling(intervalMs = 250): void {
    this.eluSamples = [];
    this.eluStartedAt = Date.now();

    void this.evaluateElu();

    const timer = setInterval(() => {
      void this.evaluateElu().then((utilization) => {
        if (utilization !== undefined) {
          this.eluSamples.push({ atMs: Date.now() - this.eluStartedAt, utilization });
        }
      });
    }, intervalMs);

    timer.unref();
    this.eluTimer = timer;
  }

  /**
   * Stashes the previous reading on globalThis inside the target so each call
   * reports the delta since the last sample. A raw
   * `performance.eventLoopUtilization()` is a since-boot average, which idle
   * boot time drags down and which never recovers during a short run.
   */
  private async evaluateElu(): Promise<number | undefined> {
    try {
      const res = await this.session.send<{ result: { value?: number } }>("Runtime.evaluate", {
        expression: `(() => {
          const now = performance.eventLoopUtilization();
          const prev = globalThis.__benchLastElu;
          globalThis.__benchLastElu = now;
          if (!prev) return 0;
          const diff = performance.eventLoopUtilization(now, prev);
          return Number.isFinite(diff.utilization) ? diff.utilization : 0;
        })()`,
        returnByValue: true,
      });
      return res.result?.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Drops the seeded first sample, which spans the gap between attach and the
   * start of load and therefore reads artificially low.
   */
  stopEluSampling(): { stats: EluStats; samples: EluSample[] } {
    if (this.eluTimer) {
      clearInterval(this.eluTimer);
      this.eluTimer = null;
    }

    const samples = this.eluSamples.slice(1);
    if (samples.length === 0) {
      return { stats: { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, sampleCount: 0 }, samples };
    }

    const sorted = samples.map((s) => s.utilization).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;

    return {
      stats: {
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: sorted[sorted.length - 1]!,
        sampleCount: sorted.length,
      },
      samples,
    };
  }

  detach(): void {
    this.stopEluSampling();
    this.session.close();
  }
}
