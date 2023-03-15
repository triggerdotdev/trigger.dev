import { TriggerKeyValueStorage } from "./types";

export type KvSetFunction = (operation: {
  key: string;
  namespace: string;
  idempotencyKey: string;
  value: any;
}) => Promise<void>;
export type KvGetFunction = (operation: {
  key: string;
  namespace: string;
  idempotencyKey: string;
}) => Promise<any>;
export type KvDeleteFunction = (operation: {
  key: string;
  namespace: string;
  idempotencyKey: string;
}) => Promise<any>;

export class ContextKeyValueStorage implements TriggerKeyValueStorage {
  getCount: number = 0;
  setCount: number = 0;
  deleteCount: number = 0;

  constructor(
    private namespace: string,
    private onGet: KvGetFunction,
    private onSet: KvSetFunction,
    private onDelete: KvDeleteFunction
  ) {}

  get<T>(key: string): Promise<T | undefined> {
    const operation = {
      key,
      namespace: this.namespace,
      idempotencyKey: `get:${this.namespace}:${key}:${this.getCount++}`,
    };

    return this.onGet(operation);
  }
  set<T>(key: string, value: T): Promise<void> {
    const operation = {
      key,
      namespace: this.namespace,
      idempotencyKey: `set:${this.namespace}:${key}:${this.setCount++}`,
      value,
    };

    return this.onSet(operation);
  }

  delete(key: string): Promise<void> {
    const operation = {
      key,
      namespace: this.namespace,
      idempotencyKey: `delete:${this.namespace}:${key}:${this.deleteCount++}`,
    };

    return this.onDelete(operation);
  }
}
