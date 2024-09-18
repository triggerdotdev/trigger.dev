type HeartbeatServiceOptions = {
  heartbeat: () => Promise<void>;
  pingIntervalInMs?: number;
  leadingEdge?: boolean;
};

export class HeartbeatService {
  private _heartbeat: () => Promise<void>;
  private _heartbeatIntervalInMs: number;
  private _nextHeartbeat: NodeJS.Timeout | undefined;
  private _leadingEdge: boolean;

  constructor(opts: HeartbeatServiceOptions) {
    this._heartbeat = opts.heartbeat;
    this._heartbeatIntervalInMs = opts.pingIntervalInMs ?? 45_000;
    this._nextHeartbeat = undefined;
    this._leadingEdge = opts.leadingEdge ?? false;
  }

  start() {
    if (this._leadingEdge) {
      this.#doHeartbeat();
    } else {
      this.#scheduleNextHeartbeat();
    }
  }

  stop() {
    this.#clearNextHeartbeat();
  }

  #doHeartbeat = async () => {
    this.#clearNextHeartbeat();

    await this._heartbeat();

    this.#scheduleNextHeartbeat();
  };

  #clearNextHeartbeat() {
    if (this._nextHeartbeat) {
      clearTimeout(this._nextHeartbeat);
    }
  }

  #scheduleNextHeartbeat() {
    this._nextHeartbeat = setTimeout(this.#doHeartbeat, this._heartbeatIntervalInMs);
  }
}
