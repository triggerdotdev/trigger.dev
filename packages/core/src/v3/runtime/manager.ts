export interface RuntimeManager {
  disable(): void;
  waitUntil(date: Date): Promise<void>;
}
