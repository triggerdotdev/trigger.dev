import { EventEmitter } from "events";
import { singleton } from "~/utils/singleton";

export type SignalsEvents = {
  SIGTERM: [
    {
      time: Date;
      signal: NodeJS.Signals;
    }
  ];
  SIGINT: [
    {
      time: Date;
      signal: NodeJS.Signals;
    }
  ];
};

export type SignalsEventArgs<T extends keyof SignalsEvents> = SignalsEvents[T];

export type SignalsEmitter = EventEmitter<SignalsEvents>;

function initializeSignalsEmitter() {
  const emitter = new EventEmitter<SignalsEvents>();

  process.on("SIGTERM", () => emitter.emit("SIGTERM", { time: new Date(), signal: "SIGTERM" }));
  process.on("SIGINT", () => emitter.emit("SIGINT", { time: new Date(), signal: "SIGINT" }));

  return emitter;
}

export const signalsEmitter = singleton("signalsEmitter", initializeSignalsEmitter);
