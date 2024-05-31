import { UsageManager, UsageMeasurement, UsageSample } from "./types";
import { clock } from "../clock-api";
import { ClockTime, calculateDurationInMs } from "../clock/clock";

class DevUsageMeasurement implements UsageMeasurement {
  private _pauses: Array<{ start: ClockTime; end: ClockTime }> = [];

  constructor(
    public readonly id: string,
    private startedAt: ClockTime = clock.preciseNow()
  ) {}

  sample(): UsageSample {
    const wallTime = this.startedAt ? calculateDurationInMs(this.startedAt, clock.preciseNow()) : 0;

    if (wallTime === 0) {
      return { cpuTime: 0, wallTime: 0 };
    }

    const totalPauses = this._pauses.reduce((total, pause) => {
      return total + calculateDurationInMs(pause.start, pause.end);
    }, 0);

    const cpuTime = wallTime - totalPauses;

    return {
      wallTime,
      cpuTime,
    };
  }

  registerPause(start: ClockTime, end: ClockTime) {
    this._pauses.push({ start, end });
  }
}

export class DevUsageManager implements UsageManager {
  private _currentMeasurements: Map<string, DevUsageMeasurement> = new Map();
  private _pauses: Array<{ start: ClockTime; end: ClockTime }> = [];

  disable(): void {}

  start(): DevUsageMeasurement {
    // generate a random ID
    const id = generateRandomString();

    const measurement = new DevUsageMeasurement(id);

    this._currentMeasurements.set(id, measurement);

    return measurement;
  }

  stop(measurement: DevUsageMeasurement): UsageSample {
    const sample = measurement.sample();

    this._currentMeasurements.delete(measurement.id);

    return sample;
  }

  async pauseAsync<T>(cb: () => Promise<T>): Promise<T> {
    const pauseStart = clock.preciseNow();

    try {
      return await cb();
    } finally {
      const pauseEnd = clock.preciseNow();

      this._pauses.push({ start: pauseStart, end: pauseEnd });

      for (const measurement of this._currentMeasurements.values()) {
        measurement.registerPause(pauseStart, pauseEnd);
      }
    }
  }
}

function generateRandomString() {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;

  for (var i = 0; i < 16; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }

  return result;
}
