export type UsageSample = {
  cpuTime: number;
  wallTime: number;
};

export interface UsageMeasurement {
  sample(): UsageSample;
}

export type InitialUsageState = {
  cpuTime: number;
  costInCents: number;
};

export interface UsageManager {
  disable(): void;
  getInitialState(): InitialUsageState;
  start(): UsageMeasurement;
  stop(measurement: UsageMeasurement): UsageSample;
  sample(): UsageSample | undefined;
  pauseAsync<T>(cb: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  reset(): void;
}
