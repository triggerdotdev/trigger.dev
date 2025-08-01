import { Context } from "@opentelemetry/api";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { TraceContextManager } from "./types.js";

const API_NAME = "trace-context";

class NoopTraceContextManager implements TraceContextManager {
  getTraceContext() {
    return {};
  }

  reset() {}

  getExternalTraceContext() {
    return undefined;
  }

  extractContext(): Context {
    throw new Error("extractContext is not implemented");
  }

  withExternalTrace<T>(fn: () => T): T {
    return fn();
  }
}

const NOOP_TRACE_CONTEXT_MANAGER = new NoopTraceContextManager();

export class TraceContextAPI implements TraceContextManager {
  private static _instance?: TraceContextAPI;

  private constructor() {}

  public static getInstance(): TraceContextAPI {
    if (!this._instance) {
      this._instance = new TraceContextAPI();
    }

    return this._instance;
  }

  public setGlobalManager(manager: TraceContextManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public reset() {
    this.#getManager().reset();
    this.disable();
  }

  public getTraceContext() {
    return this.#getManager().getTraceContext();
  }

  public getExternalTraceContext() {
    return this.#getManager().getExternalTraceContext();
  }

  public extractContext() {
    return this.#getManager().extractContext();
  }

  public withExternalTrace<T>(fn: () => T): T {
    return this.#getManager().withExternalTrace(fn);
  }

  #getManager(): TraceContextManager {
    return getGlobal(API_NAME) ?? NOOP_TRACE_CONTEXT_MANAGER;
  }
}
