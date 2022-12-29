export * from "./trigger";
export * from "./events";

import { triggerRunLocalStorage } from "./localStorage";

export function getTriggerRun() {
  return triggerRunLocalStorage.getStore();
}
