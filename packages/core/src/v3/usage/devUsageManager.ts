import { UsageManager, UsageMeasurement, UsageSample } from "./types.js";
import { clock } from "../clock-api.js";
import { ClockTime, calculateDurationInMs } from "../clock/clock.js";

class DevUsageMeasurement implements UsageMeasurement {
  private _pauses: Map<string, { start: ClockTime; end?: ClockTime }> = new Map();
  private _endedAt: ClockTime | undefined;

  constructor(
    public readonly id: string,
    private startedAt: ClockTime = clock.preciseNow()
  ) {}

  stop() {
    this._endedAt = clock.preciseNow();
  }

  sample(): UsageSample {
    const endedAt = this._endedAt ?? clock.preciseNow();

    const wallTime = this.startedAt ? calculateDurationInMs(this.startedAt, endedAt) : 0;

    if (wallTime === 0) {
      return { cpuTime: 0, wallTime: 0 };
    }

    const totalPauses = Array.from(this._pauses.values()).reduce((total, pause) => {
      return total + calculateDurationInMs(pause.start, pause.end ?? endedAt);
    }, 0);

    const cpuTime = wallTime - totalPauses;

    return {
      wallTime,
      cpuTime,
    };
  }

  registerPause(pauseId: string, start: ClockTime, end?: ClockTime) {
    this._pauses.set(pauseId, { start, end });
  }
}

export class DevUsageManager implements UsageManager {
  private _firstMeasurement?: DevUsageMeasurement;
  private _currentMeasurements: Map<string, DevUsageMeasurement> = new Map();
  private _pauses: Map<string, { start: ClockTime; end?: ClockTime }> = new Map();

  disable(): void {}

  async flush(): Promise<void> {}

  reset(): void {
    this._firstMeasurement = undefined;
    this._currentMeasurements.clear();
    this._pauses.clear();
  }

  sample(): UsageSample | undefined {
    return this._firstMeasurement?.sample();
  }

  start(): DevUsageMeasurement {
    // generate a random ID
    const id = generateRandomString();

    const measurement = new DevUsageMeasurement(id);

    if (!this._firstMeasurement) {
      this._firstMeasurement = measurement;
    }

    this._currentMeasurements.set(id, measurement);

    return measurement;
  }

  stop(measurement: DevUsageMeasurement): UsageSample {
    measurement.stop();

    const sample = measurement.sample();

    if (this._currentMeasurements.has(measurement.id)) {
      this._currentMeasurements.delete(measurement.id);
    }

    return sample;
  }

  async pauseAsync<T>(cb: () => Promise<T>): Promise<T> {
    const pauseId = generateRandomString();

    const pauseStart = clock.preciseNow();

    try {
      this._pauses.set(pauseId, { start: pauseStart });

      for (const measurement of this._currentMeasurements.values()) {
        measurement.registerPause(pauseId, pauseStart);
      }

      return await cb();
    } finally {
      const pauseEnd = clock.preciseNow();

      this._pauses.set(pauseId, { start: pauseStart, end: pauseEnd });

      for (const measurement of this._currentMeasurements.values()) {
        measurement.registerPause(pauseId, pauseStart, pauseEnd);
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
