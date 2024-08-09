import { BuildTarget, TaskRunExecutionPayload, TaskRunExecutionResult } from "@trigger.dev/core/v3";
import { EventEmitter } from "node:events";
import { BackgroundWorker } from "../dev/backgroundWorker.js";

export type EventBusEvents = {
  rebuildStarted: [BuildTarget];
  buildStarted: [BuildTarget];
  workerSkipped: [];
  backgroundWorkerInitialized: [BackgroundWorker];
  runStarted: [BackgroundWorker, TaskRunExecutionPayload];
  runCompleted: [BackgroundWorker, TaskRunExecutionPayload, TaskRunExecutionResult, number];
};

export type EventBusEventArgs<T extends keyof EventBusEvents> = EventBusEvents[T];

export const eventBus = new EventEmitter<EventBusEvents>();
