import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatTabCoordinator } from "./chat-tab-coordinator.js";

// Mock BroadcastChannel for testing
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(public name: string) {
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    // Deliver to all OTHER instances on the same channel
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && !instance.closed) {
        instance.onmessage?.({ data } as MessageEvent);
      }
    }
  }

  close(): void {
    this.closed = true;
    MockBroadcastChannel.instances = MockBroadcastChannel.instances.filter((i) => i !== this);
  }
}

describe("ChatTabCoordinator", () => {
  beforeEach(() => {
    MockBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("tab A claims, tab B sees isReadOnly", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();

    expect(b.isReadOnly("chat-1")).toBe(false);

    a.claim("chat-1");

    expect(b.isReadOnly("chat-1")).toBe(true);
    expect(a.isReadOnly("chat-1")).toBe(false); // Owner is not read-only

    a.dispose();
    b.dispose();
  });

  it("tab A releases, tab B sees isReadOnly = false", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();

    a.claim("chat-1");
    expect(b.isReadOnly("chat-1")).toBe(true);

    a.release("chat-1");
    expect(b.isReadOnly("chat-1")).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("fires listener on claim and release", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();
    const listener = vi.fn();
    b.addListener(listener);

    a.claim("chat-1");
    expect(listener).toHaveBeenCalledWith("chat-1", true);

    a.release("chat-1");
    expect(listener).toHaveBeenCalledWith("chat-1", false);

    a.dispose();
    b.dispose();
  });

  it("removeListener stops notifications", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();
    const listener = vi.fn();
    b.addListener(listener);
    b.removeListener(listener);

    a.claim("chat-1");
    expect(listener).not.toHaveBeenCalled();

    a.dispose();
    b.dispose();
  });

  it("claim returns false when another tab holds the chatId", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();

    expect(a.claim("chat-1")).toBe(true);
    expect(b.claim("chat-1")).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("supports multiple independent chatIds", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();

    a.claim("chat-1");
    b.claim("chat-2");

    expect(a.isReadOnly("chat-1")).toBe(false);
    expect(a.isReadOnly("chat-2")).toBe(true);
    expect(b.isReadOnly("chat-1")).toBe(true);
    expect(b.isReadOnly("chat-2")).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("heartbeat timeout clears stale claim from crashed tab", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();
    const listener = vi.fn();
    b.addListener(listener);

    a.claim("chat-1");
    expect(b.isReadOnly("chat-1")).toBe(true);

    // Simulate tab A crashing (close its channel, stop heartbeats)
    a.dispose();

    // Advance past heartbeat timeout (10s)
    vi.advanceTimersByTime(11_000);

    expect(b.isReadOnly("chat-1")).toBe(false);
    expect(listener).toHaveBeenCalledWith("chat-1", false);

    b.dispose();
  });

  it("dispose releases all claims", () => {
    const a = new ChatTabCoordinator();
    const b = new ChatTabCoordinator();

    a.claim("chat-1");
    a.claim("chat-2");
    expect(b.isReadOnly("chat-1")).toBe(true);
    expect(b.isReadOnly("chat-2")).toBe(true);

    a.dispose();
    expect(b.isReadOnly("chat-1")).toBe(false);
    expect(b.isReadOnly("chat-2")).toBe(false);

    b.dispose();
  });

  it("gracefully degrades when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("BroadcastChannel", undefined);

    const coord = new ChatTabCoordinator();

    // All operations are no-ops
    expect(coord.claim("chat-1")).toBe(true);
    expect(coord.isReadOnly("chat-1")).toBe(false);
    coord.release("chat-1"); // No error
    coord.dispose(); // No error
  });
});
