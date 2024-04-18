import { TimerOptions } from "node:timers";
import { setTimeout } from "node:timers/promises";

export async function unboundedTimeout<T = void>(
  delay: number = 0,
  value?: T,
  options?: TimerOptions
): Promise<T> {
  const maxDelay = 2147483647; // Highest value that will fit in a 32-bit signed integer

  const fullTimeouts = Math.floor(delay / maxDelay);
  const remainingDelay = delay % maxDelay;

  let lastTimeoutResult = await setTimeout(remainingDelay, value, options);

  for (let i = 0; i < fullTimeouts; i++) {
    lastTimeoutResult = await setTimeout(maxDelay, value, options);
  }

  return lastTimeoutResult;
}
