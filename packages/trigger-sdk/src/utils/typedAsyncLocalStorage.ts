import { AsyncLocalStorage } from "async_hooks";

export class TypedAsyncLocalStorage<T> {
  private storage: AsyncLocalStorage<T>;

  constructor() {
    this.storage = new AsyncLocalStorage<T>();
  }

  runWith<R extends (...args: any[]) => Promise<any>>(context: T, fn: R): Promise<ReturnType<R>> {
    return this.storage.run(context, fn);
  }

  getStore(): T | undefined {
    return this.storage.getStore();
  }
}
