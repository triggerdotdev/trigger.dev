type HeartbeatServiceOptions = {
  heartbeat: () => Promise<void>;
  intervalMs?: number;
  leadingEdge?: boolean;
  onError?: (error: unknown) => Promise<void>;
};

export class HeartbeatService {
  private _heartbeat: () => Promise<void>;
  private _intervalMs: number;
  private _nextHeartbeat: NodeJS.Timeout | undefined;
  private _leadingEdge: boolean;
  private _isHeartbeating: boolean;
  private _onError?: (error: unknown) => Promise<void>;

  constructor(opts: HeartbeatServiceOptions) {
    this._heartbeat = opts.heartbeat;
    this._intervalMs = opts.intervalMs ?? 45_000;
    this._nextHeartbeat = undefined;
    this._leadingEdge = opts.leadingEdge ?? false;
    this._isHeartbeating = false;
    this._onError = opts.onError;
  }

  start() {
    if (this._isHeartbeating) {
      return;
    }

    this._isHeartbeating = true;

    if (this._leadingEdge) {
      this.#doHeartbeat();
    } else {
      this.#scheduleNextHeartbeat();
    }
  }

  stop() {
    if (!this._isHeartbeating) {
      return;
    }

    this._isHeartbeating = false;
    this.#clearNextHeartbeat();
  }

  resetCurrentInterval() {
    if (!this._isHeartbeating) {
      return;
    }

    this.#clearNextHeartbeat();
    this.#scheduleNextHeartbeat();
  }

  updateInterval(intervalMs: number) {
    this._intervalMs = intervalMs;
    this.resetCurrentInterval();
  }

  #doHeartbeat = async () => {
    this.#clearNextHeartbeat();

    if (!this._isHeartbeating) {
      return;
    }

    try {
      await this._heartbeat();
    } catch (error) {
      if (this._onError) {
        try {
          await this._onError(error);
        } catch (error) {
          console.error("Error handling heartbeat error", error);
        }
      }
    }

    this.#scheduleNextHeartbeat();
  };

  #clearNextHeartbeat() {
    if (this._nextHeartbeat) {
      clearTimeout(this._nextHeartbeat);
    }
  }

  #scheduleNextHeartbeat() {
    this._nextHeartbeat = setTimeout(this.#doHeartbeat, this._intervalMs);
  }
}
