/**
 * Contains two parts: the first part is the seconds, the second part is the nanoseconds.
 *
 */
export type ClockTime = [number, number];

export interface Clock {
  preciseNow(): ClockTime;
  reset(): void;
}

export function calculateDurationInMs(start: ClockTime, end: ClockTime): number {
  const [startSeconds, startNanoseconds] = start;
  const [endSeconds, endNanoseconds] = end;

  const seconds = endSeconds - startSeconds;
  const nanoseconds = endNanoseconds - startNanoseconds;

  return Math.floor(seconds * 1000 + nanoseconds / 1000000);
}
