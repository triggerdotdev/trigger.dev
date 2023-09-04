import type { AuthenticatedTask } from "@trigger.dev/sdk";
import { DummyClientType } from "./types";

function onTaskError(error: unknown) {
  return;
}

export const taskOne: AuthenticatedTask<DummyClientType, Record<string, any>, void> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.methodOne();
  },
  init: (params) => {
    return {
      name: "Task One",
      params,
    };
  },
};

export const taskTwo: AuthenticatedTask<DummyClientType, Record<string, any>, void> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.methodTwo();
  },
  init: (params) => {
    return {
      name: "Task Two",
      params,
    };
  },
};
