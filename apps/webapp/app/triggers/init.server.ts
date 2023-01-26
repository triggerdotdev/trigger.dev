import { uptimeCheck, healthCheck, checkScheduler } from "./monitoring.server";

declare global {
  var __triggers_initialized: boolean;
}

export function init() {
  if (global.__triggers_initialized) {
    return;
  }

  global.__triggers_initialized = true;

  uptimeCheck.listen();
  healthCheck.listen();
  checkScheduler.listen();

  console.log(`🛎 Triggers initialized`);
}
