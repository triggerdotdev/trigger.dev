export class AsyncWorker {
  private running = false;
  private timeout?: NodeJS.Timeout;

  constructor(private readonly fn: () => Promise<void>, private readonly interval: number) {}

  start() {
    if (this.running) {
      return;
    }

    this.running = true;

    this.#run();
  }

  stop() {
    this.running = false;
  }

  async #run() {
    if (!this.running) {
      return;
    }

    try {
      await this.fn();
    } catch (e) {
      console.error(e);
    }

    this.timeout = setTimeout(this.#run.bind(this), this.interval);
  }
}
