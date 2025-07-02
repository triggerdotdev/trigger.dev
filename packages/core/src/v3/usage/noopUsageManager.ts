import { UsageManager, UsageMeasurement, UsageSample } from "./types.js";

export class NoopUsageManager implements UsageManager {
  disable(): void {
    // Noop
  }

  async flush(): Promise<void> {
    // Noop
  }

  start(): UsageMeasurement {
    return {
      sample: () => ({ cpuTime: 0, wallTime: 0 }),
    };
  }

  stop(measurement: UsageMeasurement): UsageSample {
    return measurement.sample();
  }

  pauseAsync<T>(cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  sample(): UsageSample | undefined {
    return undefined;
  }

  reset(): void {
    // Noop
  }
}
