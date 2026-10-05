import type { WorkerQueueSelection } from "./types.js";

export function weightedWorkerQueueOrder(
  selections: readonly WorkerQueueSelection[],
  random: () => number = Math.random
): string[] {
  const uniqueSelections = new Map<string, WorkerQueueSelection>();

  for (const selection of selections) {
    if (!Number.isFinite(selection.weight) || selection.weight < 0 || selection.weight > 1) {
      throw new Error(
        `Worker queue weight must be finite and between 0 and 1: ${selection.weight}`
      );
    }
    if (!uniqueSelections.has(selection.queue)) {
      uniqueSelections.set(selection.queue, selection);
    }
  }

  return [...uniqueSelections.values()]
    .filter(({ weight }) => weight > 0)
    .map(({ queue, weight }) => ({
      queue,
      // This is the logarithm of an exponential-race score. It preserves ordering while
      // avoiding overflow when valid weights are close to Number.MIN_VALUE.
      score: Math.log(-Math.log1p(-random())) - Math.log(weight),
    }))
    .sort((left, right) => left.score - right.score)
    .map(({ queue }) => queue);
}
