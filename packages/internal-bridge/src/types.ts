import { Evt } from "evt";

export interface IConnection {
  id: string;
  onMessage: Evt<string>;
  onClose: Evt<[number, string]>;
  onOpen: Evt<void>;
  onError: Evt<Error>;

  send(data: string): Promise<void>;
  close(code?: number, reason?: string): void;
}
