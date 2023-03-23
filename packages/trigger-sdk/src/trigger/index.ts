import { LogLevel } from "internal-bridge";
import { EntryPoint } from "../entryPoint";
import { TriggerEvent } from "../events";
import type { TriggerContext } from "../types";

export type TriggerOptions<TEventType = any> = {
  id: string;
  name: string;
  on: TriggerEvent<TEventType>;
  logLevel?: LogLevel;

  run: (event: TEventType, ctx: TriggerContext) => Promise<any>;
};

export class Trigger<TEventType = any> {
  options: TriggerOptions<TEventType>;

  constructor(options: TriggerOptions<TEventType>) {
    this.options = options;
  }

  register(entryPoint: EntryPoint) {
    entryPoint.register(this);
  }

  get id() {
    return this.options.id;
  }

  get name() {
    return this.options.name;
  }

  get on() {
    return this.options.on;
  }
}
