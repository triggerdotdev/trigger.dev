import type { Execa$ } from "execa";
import { setTimeout as timeout } from "node:timers/promises";

class ChaosMonkeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaosMonkeyError";
  }
}

export class ChaosMonkey {
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
    throwErrors,
    addDelays,
  }: {
    $?: Execa$<string>;
    throwErrors?: boolean;
    addDelays?: boolean;
  } = {}) {
    if (!this.enabled) {
      return;
    }

    const random = Math.random();

    if (random < 0.33) {
      if (!addDelays) {
        return;
      }

      console.log("🍌 Chaos monkey: Add delay");

      if ($) {
        await $`sleep 300`;
      } else {
        await timeout(300_000);
      }
    } else if (random < 0.66) {
      if (!throwErrors) {
        return;
      }

      console.log("🍌 Chaos monkey: Throw error");

      if ($) {
        await $`false`;
      } else {
        throw new ChaosMonkey.Error("🍌 Chaos monkey: Throw error");
      }
    } else {
      // no-op
    }
  }
}
