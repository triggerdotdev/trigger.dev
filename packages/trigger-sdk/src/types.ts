import type { SecureString } from "@trigger.dev/internal";

export type { SecureString };

export interface TriggerContext {
  id: string;
  version: string;
  environment: string;
  organization: string;
  startedAt: Date;
  isTest: boolean;
  logger: TaskLogger;
  signal: AbortSignal;
  wait(key: string, seconds: number): Promise<void>;
  // sendEvent(key: string, event: TriggerCustomEvent): Promise<void>;
  // waitUntil(key: string, date: Date): Promise<void>;
  // runOnce<T extends TriggerRunOnceCallback>(
  //   key: string,
  //   callback: T
  // ): Promise<Awaited<ReturnType<T>>>;
  // runOnceLocalOnly<T extends TriggerRunOnceCallback>(
  //   key: string,
  //   callback: T
  // ): Promise<Awaited<ReturnType<T>>>;
  // fetch: TriggerFetch;
  // kv: TriggerKeyValueStorage;
  // globalKv: TriggerKeyValueStorage;
  // runKv: TriggerKeyValueStorage;
}

export interface TaskLogger {
  debug(message: string, properties?: Record<string, any>): Promise<void>;
  info(message: string, properties?: Record<string, any>): Promise<void>;
  warn(message: string, properties?: Record<string, any>): Promise<void>;
  error(message: string, properties?: Record<string, any>): Promise<void>;
}
