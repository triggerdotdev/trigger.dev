import { EventEmitter } from "node:events";

export type EventBusEvents = {
  runExpired: [
    {
      time: Date;
      run: {
        id: string;
        spanId: string;
        ttl: string | null;
      };
    },
  ];
};

export type EventBusEventArgs<T extends keyof EventBusEvents> = EventBusEvents[T];
