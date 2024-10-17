import { AsyncLocalStorage } from "node:async_hooks";

export class SafeAsyncLocalStorage<T> {
  private storage: AsyncLocalStorage<T>;

  constructor() {
    this.storage = new AsyncLocalStorage<T>();
  }

  enterWith(context: T): void {
    this.storage.enterWith(context);
  }

  runWith<R extends (...args: any[]) => Promise<any>>(context: T, fn: R): Promise<ReturnType<R>> {
    return this.storage.run(context, fn);
  }

  getStore(): T | undefined {
    return this.storage.getStore();
  }
}
