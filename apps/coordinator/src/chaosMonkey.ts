import type { Execa$ } from "execa";
import { setTimeout as timeout } from "node:timers/promises";

class ChaosMonkeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaosMonkeyError";
  }
}

export class ChaosMonkey {
  private chaosEventRate = 0.2;

  constructor(private enabled = false) {
    if (this.enabled) {
      console.log("🍌 Chaos monkey enabled");
    }
  }

  static Error = ChaosMonkeyError;

  enable() {
    this.enabled = true;
    console.log("🍌 Chaos monkey enabled");
  }

  disable() {
    this.enabled = false;
    console.log("🍌 Chaos monkey disabled");
  }

  async call({
    $,
    throwErrors = true,
    addDelays = true,
  }: {
    $?: Execa$<string>;
    throwErrors?: boolean;
    addDelays?: boolean;
  } = {}) {
    if (!this.enabled) {
      return;
    }

    const random = Math.random();

    if (random > this.chaosEventRate) {
      // Don't interfere with normal operation
      return;
    }

    const chaosEvents: Array<() => Promise<any>> = [];

    if (addDelays) {
      chaosEvents.push(async () => {
        console.log("🍌 Chaos monkey: Add delay");

        if ($) {
          await $`sleep 300`;
        } else {
          await timeout(300_000);
        }
      });
    }

    if (throwErrors) {
      chaosEvents.push(async () => {
        console.log("🍌 Chaos monkey: Throw error");

        if ($) {
          await $`false`;
        } else {
          throw new ChaosMonkey.Error("🍌 Chaos monkey: Throw error");
        }
      });
    }

    if (chaosEvents.length === 0) {
      console.error("🍌 Chaos monkey: No events selected");
      return;
    }

    const randomIndex = Math.floor(Math.random() * chaosEvents.length);

    const chaosEvent = chaosEvents[randomIndex];

    if (!chaosEvent) {
      console.error("🍌 Chaos monkey: No event found");
      return;
    }

    await chaosEvent();
  }
}
