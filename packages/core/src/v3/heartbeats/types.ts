export interface HeartbeatsManager {
  startHeartbeat(id: string): void;
  stopHeartbeat(): void;
  yield(): Promise<void>;
  reset(): void;

  get lastHeartbeat(): Date | undefined;
}
