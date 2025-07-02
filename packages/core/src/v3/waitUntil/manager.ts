import { MaybeDeferredPromise, WaitUntilManager } from "./types.js";

export class StandardWaitUntilManager implements WaitUntilManager {
  private maybeDeferredPromises: Set<MaybeDeferredPromise> = new Set();

  reset(): void {
    this.maybeDeferredPromises.clear();
  }

  register(promise: MaybeDeferredPromise): void {
    this.maybeDeferredPromises.add(promise);
  }

  async blockUntilSettled(timeout: number): Promise<void> {
    if (this.promisesRequringResolving.length === 0) {
      return;
    }

    const promises = this.promisesRequringResolving.map((p) =>
      typeof p.promise === "function" ? p.promise() : p.promise
    );

    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve, _) => setTimeout(() => resolve(), timeout)),
    ]);

    this.maybeDeferredPromises.clear();
  }

  requiresResolving(): boolean {
    return this.promisesRequringResolving.length > 0;
  }

  private get promisesRequringResolving(): MaybeDeferredPromise[] {
    return Array.from(this.maybeDeferredPromises).filter((p) => p.requiresResolving());
  }
}
