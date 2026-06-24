import type { BackpressureSignalSource, BackpressureVerdict } from "./backpressureMonitor.js";

// Reads the apiserver's stored-pod-object count from a Prometheus /metrics scrape.
const POD_COUNT_RE = /^apiserver_storage_objects\{[^}]*resource="pods"[^}]*\}\s+([0-9.eE+]+)/m;

export function parsePodCount(metricsText: string): number {
  const match = metricsText.match(POD_COUNT_RE);
  if (!match) {
    throw new Error('apiserver_storage_objects{resource="pods"} not found in metrics');
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`unparseable pod count: ${match[1]}`);
  }
  return value;
}

export type K8sPodCountSignalSourceOptions = {
  fetchMetrics: () => Promise<string>;
  engageThreshold: number;
  releaseThreshold: number;
  reportPodCount?: (count: number) => void;
};

// Engage/release with hysteresis so a count hovering near the line doesn't flap.
export class K8sPodCountSignalSource implements BackpressureSignalSource {
  private engaged = false;

  constructor(private readonly opts: K8sPodCountSignalSourceOptions) {}

  async read(): Promise<BackpressureVerdict> {
    const text = await this.opts.fetchMetrics();
    const count = parsePodCount(text);
    this.opts.reportPodCount?.(count);

    if (this.engaged) {
      if (count < this.opts.releaseThreshold) {
        this.engaged = false;
      }
    } else if (count >= this.opts.engageThreshold) {
      this.engaged = true;
    }

    return { engaged: this.engaged, ts: Date.now() };
  }
}
