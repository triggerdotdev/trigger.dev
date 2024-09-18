import { PreciseDate } from "@google-cloud/precise-date";
import { Clock, ClockTime } from "./clock.js";

export type PreciseWallClockOptions = {
  origin?: ClockTime;
  now?: PreciseDate;
};

export class PreciseWallClock implements Clock {
  private _origin: {
    clockTime: ClockTime;
    preciseDate: PreciseDate;
  };

  get #originClockTime() {
    return this._origin.clockTime;
  }

  get #originPreciseDate() {
    return this._origin.preciseDate;
  }

  constructor(options: PreciseWallClockOptions = {}) {
    this._origin = {
      clockTime: options.origin ?? process.hrtime(),
      preciseDate: options.now ?? new PreciseDate(),
    };
  }

  preciseNow(): [number, number] {
    const elapsedHrTime = process.hrtime(this.#originClockTime);
    const elapsedNanoseconds = BigInt(elapsedHrTime[0]) * BigInt(1e9) + BigInt(elapsedHrTime[1]);

    const preciseDate = new PreciseDate(this.#originPreciseDate.getFullTime() + elapsedNanoseconds);
    const dateStruct = preciseDate.toStruct();

    return [dateStruct.seconds, dateStruct.nanos];
  }

  reset() {
    this._origin = {
      clockTime: process.hrtime(),
      preciseDate: new PreciseDate(),
    };
  }
}
