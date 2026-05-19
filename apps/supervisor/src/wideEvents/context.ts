import { AsyncLocalStorage } from "node:async_hooks";
import type { State } from "./state.js";

/**
 * AsyncLocalStorage threading per-operation `State` through the call stack.
 * Wrappers enter a state via `wideEventStorage.run(state, () => fn())` and
 * any code in the async call tree retrieves it via `fromContext()`.
 */
export const wideEventStorage = new AsyncLocalStorage<State>();

/** Returns the State attached to the current async context, or null. */
export function fromContext(): State | null {
  return wideEventStorage.getStore() ?? null;
}
