export class Throttle {
  throttleTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly fn: () => any,
    private readonly delay: number
  ) {
    this.fn = fn;
    this.delay = delay;
  }

  call() {
    if (this.throttleTimeout) {
      clearTimeout(this.throttleTimeout);
    }
    this.throttleTimeout = setTimeout(this.fn, this.delay);
  }
}
