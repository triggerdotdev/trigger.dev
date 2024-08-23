import { PreciseDate } from "@google-cloud/precise-date";
import { Clock } from "./clock.js";

export class SimpleClock implements Clock {
  preciseNow(): [number, number] {
    const now = new PreciseDate();
    const nowStruct = now.toStruct();

    return [nowStruct.seconds, nowStruct.nanos];
  }

  reset() {
    // do nothing
  }
}
