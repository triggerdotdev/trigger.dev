export type UsageSample = {
  cpuTime: number;
  wallTime: number;
};

export interface UsageMeasurement {
  sample(): UsageSample;
}

export interface UsageManager {
  disable(): void;
  start(): UsageMeasurement;
  stop(measurement: UsageMeasurement): UsageSample;
  sample(): UsageSample | undefined;
  pauseAsync<T>(cb: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
}
