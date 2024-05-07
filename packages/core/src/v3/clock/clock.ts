export type ClockTime = [number, number];

export interface Clock {
  preciseNow(): ClockTime;
  reset(): void;
}
