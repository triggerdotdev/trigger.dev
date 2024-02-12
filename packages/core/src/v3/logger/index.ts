import { NoopTaskLogger, TaskLogger } from "./taskLogger";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals";

const API_NAME = "logger";

const NOOP_TASK_LOGGER = new NoopTaskLogger();

export class LoggerAPI implements TaskLogger {
  private static _instance?: LoggerAPI;

  private constructor() {}

  public static getInstance(): LoggerAPI {
    if (!this._instance) {
      this._instance = new LoggerAPI();
    }

    return this._instance;
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public setGlobalTaskLogger(taskLogger: TaskLogger): boolean {
    return registerGlobal(API_NAME, taskLogger);
  }

  public debug(message: string, metadata?: Record<string, unknown>) {
    this.#getTaskLogger().debug(message, metadata);
  }

  public log(message: string, metadata?: Record<string, unknown>) {
    this.#getTaskLogger().log(message, metadata);
  }

  public info(message: string, metadata?: Record<string, unknown>) {
    this.#getTaskLogger().info(message, metadata);
  }

  public warn(message: string, metadata?: Record<string, unknown>) {
    this.#getTaskLogger().warn(message, metadata);
  }

  public error(message: string, metadata?: Record<string, unknown>) {
    this.#getTaskLogger().error(message, metadata);
  }

  #getTaskLogger(): TaskLogger {
    return getGlobal(API_NAME) ?? NOOP_TASK_LOGGER;
  }
}
