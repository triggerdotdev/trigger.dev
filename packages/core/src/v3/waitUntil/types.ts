export type MaybeDeferredPromise = {
  requiresResolving(): boolean;
  promise: Promise<any> | ((timeoutInMs: number) => Promise<any>);
};

export interface WaitUntilManager {
  register(promise: MaybeDeferredPromise): void;
  blockUntilSettled(): Promise<void>;
  requiresResolving(): boolean;
}
