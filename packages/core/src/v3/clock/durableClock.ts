import { PreciseDate } from "@google-cloud/precise-date";
import { Clock, ClockTime } from "./clock";

export type DurableClockOptions = {
  origin?: ClockTime;
  now?: PreciseDate;
};

export class DurableClock implements Clock {
  private _originClockTime: ClockTime;
  private _originPreciseDate: PreciseDate;

  constructor(options: DurableClockOptions = {}) {
    this._originClockTime = options.origin ?? process.hrtime();
    this._originPreciseDate = options.now ?? new PreciseDate();
  }

  preciseNow(): [number, number] {
    const elapsedHrTime = process.hrtime(this._originClockTime);
    const elapsedNanoseconds = BigInt(elapsedHrTime[0]) * BigInt(1e9) + BigInt(elapsedHrTime[1]);

    const preciseDate = new PreciseDate(this._originPreciseDate.getFullTime() + elapsedNanoseconds);
    const dateStruct = preciseDate.toStruct();

    return [dateStruct.seconds, dateStruct.nanos];
  }
}
