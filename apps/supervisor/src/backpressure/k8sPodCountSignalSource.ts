import type { BackpressureSignalSource, BackpressureVerdict } from "./backpressureMonitor.js";

export type K8sPodCountSignalSourceOptions = {
  fetchPodCount: () => Promise<number>;
  engageThreshold: number;
  releaseThreshold: number;
  reportPodCount?: (count: number) => void;
};

// Engage/release with hysteresis so a count hovering near the line doesn't flap.
export class K8sPodCountSignalSource implements BackpressureSignalSource {
  private engaged = false;

  constructor(private readonly opts: K8sPodCountSignalSourceOptions) {}

  async read(): Promise<BackpressureVerdict> {
    const count = await this.opts.fetchPodCount();
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
