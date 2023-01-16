export * from "./events";
export * from "./trigger";
export * from "./customEvents";

import { triggerRunLocalStorage } from "./localStorage";

export function getTriggerRun() {
  return triggerRunLocalStorage.getStore();
}
