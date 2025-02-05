import {
  BuildManifest,
  BuildTarget,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { EventEmitter } from "node:events";
import { BackgroundWorker } from "../dev/backgroundWorker.js";

export type EventBusEvents = {
  rebuildStarted: [BuildTarget];
  buildStarted: [BuildTarget];
  workerSkipped: [];
  backgroundWorkerInitialized: [BackgroundWorker];
  backgroundWorkerIndexingError: [BuildManifest, Error];
  runStarted: [BackgroundWorker, TaskRunExecution];
  runCompleted: [BackgroundWorker, TaskRunExecution, TaskRunExecutionResult, number];
};

export type EventBusEventArgs<T extends keyof EventBusEvents> = EventBusEvents[T];

export const eventBus = new EventEmitter<EventBusEvents>();
