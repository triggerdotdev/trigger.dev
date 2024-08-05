const API_NAME = "clock";

import { getGlobal, registerGlobal } from "../utils/globals.js";
import type { Clock, ClockTime } from "./clock.js";
import { SimpleClock } from "./simpleClock.js";

const SIMPLE_CLOCK = new SimpleClock();

export class ClockAPI {
  private static _instance?: ClockAPI;

  private constructor() {}

  public static getInstance(): ClockAPI {
    if (!this._instance) {
      this._instance = new ClockAPI();
    }

    return this._instance;
  }

  public setGlobalClock(clock: Clock): boolean {
    return registerGlobal(API_NAME, clock);
  }

  public preciseNow(): ClockTime {
    return this.#getClock().preciseNow();
  }

  public reset(): void {
    this.#getClock().reset();
  }

  #getClock(): Clock {
    return getGlobal(API_NAME) ?? SIMPLE_CLOCK;
  }
}
