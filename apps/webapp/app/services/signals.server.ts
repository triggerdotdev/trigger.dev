import { EventEmitter } from "events";
import { singleton } from "~/utils/singleton";

type SignalsEvents = {
  SIGTERM: [
    {
      time: Date;
      signal: NodeJS.Signals;
    },
  ];
  SIGINT: [
    {
      time: Date;
      signal: NodeJS.Signals;
    },
  ];
};

type SignalsEventArgs<T extends keyof SignalsEvents> = SignalsEvents[T];

type SignalsEmitter = EventEmitter<SignalsEvents>;

function initializeSignalsEmitter() {
  const emitter = new EventEmitter<SignalsEvents>();

  process.on("SIGTERM", () => emitter.emit("SIGTERM", { time: new Date(), signal: "SIGTERM" }));
  process.on("SIGINT", () => emitter.emit("SIGINT", { time: new Date(), signal: "SIGINT" }));

  return emitter;
}

export const signalsEmitter = singleton("signalsEmitter", initializeSignalsEmitter);
