import { AsyncLocalStorage } from "node:async_hooks";

export type HttpLocalStorage = {
  requestId: string;
  path: string;
  host: string;
  method: string;
};

const httpLocalStorage = new AsyncLocalStorage<HttpLocalStorage>();

export type RunWithHttpContextFunction = <T>(context: HttpLocalStorage, fn: () => T) => T;

export function runWithHttpContext<T>(context: HttpLocalStorage, fn: () => T): T {
  return httpLocalStorage.run(context, fn);
}

export function getHttpContext(): HttpLocalStorage | undefined {
  return httpLocalStorage.getStore();
}
