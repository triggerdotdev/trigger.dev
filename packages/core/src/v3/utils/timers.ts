import { setInterval, setTimeout } from "node:timers/promises";

export async function unboundedTimeout<T = void>(
  delay: number = 0,
  value?: T,
  options?: Parameters<typeof setTimeout>[2]
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

export async function checkpointSafeTimeout(delay: number = 0): Promise<void> {
  const scanIntervalMs = 1000;

  // Every scanIntervalMs, check if delay has elapsed
  for await (const start of setInterval(scanIntervalMs, Date.now())) {
    if (Date.now() - start > delay) {
      break;
    }
  }
}
