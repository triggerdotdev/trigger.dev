import { PreciseDate } from "@google-cloud/precise-date";

export type PreciseDateOrigin = {
  hrtime: [number, number];
  timestamp: PreciseDate
}

export function preciseDateOriginNow(): PreciseDateOrigin {
  return {
    hrtime: process.hrtime(),
    timestamp: new PreciseDate()
  }
}

export function calculatePreciseDateHrTime(origin: PreciseDateOrigin): [number, number] {
  const elapsedHrTime = process.hrtime(origin.hrtime);
  const elapsedNanoseconds = BigInt(elapsedHrTime[0]) * BigInt(1e9) + BigInt(elapsedHrTime[1]);

  const preciseDate = new PreciseDate(origin.timestamp.getFullTime() + elapsedNanoseconds)
  const dateStruct = preciseDate.toStruct();

  return [dateStruct.seconds, dateStruct.nanos];
}