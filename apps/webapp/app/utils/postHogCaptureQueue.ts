type Capture = (event: string, properties?: Record<string, unknown>) => void;
const MAX_PENDING_EVENTS = 50;

export class PostHogCaptureQueue {
  private state: "pending" | "ready" | "disabled" = "pending";
  private pending: Parameters<Capture>[] = [];

  constructor(private readonly send: Capture) {}

  capture(event: string, properties?: Record<string, unknown>) {
    if (this.state === "ready") this.send(event, properties);
    else if (this.state === "pending" && this.pending.length < MAX_PENDING_EVENTS) {
      this.pending.push([event, properties]);
    }
  }

  ready() {
    this.state = "ready";
    const pending = this.pending;
    this.pending = [];
    for (const [event, properties] of pending) this.send(event, properties);
  }

  disable() {
    this.state = "disabled";
    this.pending = [];
  }
}
