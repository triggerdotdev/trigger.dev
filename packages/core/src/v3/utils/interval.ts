type IntervalServiceOptions = {
  onInterval: () => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
  intervalMs?: number;
  leadingEdge?: boolean;
};

export class IntervalService {
  private _onInterval: () => Promise<void>;
  private _onError?: (error: unknown) => Promise<void>;

  private _intervalMs: number;
  private _nextInterval: NodeJS.Timeout | undefined;
  private _leadingEdge: boolean;
  private _isEnabled: boolean;

  constructor(opts: IntervalServiceOptions) {
    this._onInterval = opts.onInterval;
    this._onError = opts.onError;

    this._intervalMs = opts.intervalMs ?? 45_000;
    this._nextInterval = undefined;
    this._leadingEdge = opts.leadingEdge ?? false;
    this._isEnabled = false;
  }

  start() {
    if (this._isEnabled) {
      return;
    }

    this._isEnabled = true;

    if (this._leadingEdge) {
      this.#doInterval();
    } else {
      this.#scheduleNextInterval();
    }
  }

  stop() {
    if (!this._isEnabled) {
      return;
    }

    this._isEnabled = false;
    this.#clearNextInterval();
  }

  resetCurrentInterval() {
    if (!this._isEnabled) {
      return;
    }

    this.#clearNextInterval();
    this.#scheduleNextInterval();
  }

  updateInterval(intervalMs: number) {
    this._intervalMs = intervalMs;
    this.resetCurrentInterval();
  }

  #doInterval = async () => {
    this.#clearNextInterval();

    if (!this._isEnabled) {
      return;
    }

    try {
      await this._onInterval();
    } catch (error) {
      if (this._onError) {
        try {
          await this._onError(error);
        } catch (error) {
          console.error("Error during interval error handler", error);
        }
      }
    }

    this.#scheduleNextInterval();
  };

  #clearNextInterval() {
    if (this._nextInterval) {
      clearTimeout(this._nextInterval);
    }
  }

  #scheduleNextInterval() {
    this._nextInterval = setTimeout(this.#doInterval, this._intervalMs);
  }
}
