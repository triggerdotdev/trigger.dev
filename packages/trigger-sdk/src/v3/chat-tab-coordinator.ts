/**
 * Coordinates multi-tab access to chat sessions via BroadcastChannel.
 *
 * When multiple browser tabs open the same chat, only one can be the active
 * sender. Others enter read-only mode. The coordinator uses a simple
 * claim/release/heartbeat protocol to track ownership per chatId.
 *
 * Gracefully degrades to a no-op when BroadcastChannel is unavailable
 * (SSR, Node.js, old browsers).
 *
 * @internal
 */

const CHANNEL_NAME = "trigger-chat-tab-coord";
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

type TabMessage =
  | { type: "claim"; chatId: string; tabId: string }
  | { type: "release"; chatId: string; tabId: string }
  | { type: "heartbeat"; chatId: string; tabId: string }
  | { type: "messages"; chatId: string; tabId: string; messages: unknown[] }
  | { type: "session"; chatId: string; tabId: string; session: { lastEventId?: string } };

type ReadOnlyListener = (chatId: string, isReadOnly: boolean) => void;
type MessagesListener = (chatId: string, messages: unknown[]) => void;
type SessionListener = (chatId: string, session: { lastEventId?: string }) => void;

export class ChatTabCoordinator {
  private tabId: string;
  private channel: BroadcastChannel | null = null;
  /** Claims held by OTHER tabs: chatId -> { tabId, lastSeen } */
  private claims = new Map<string, { tabId: string; lastSeen: number }>();
  /** chatIds that THIS tab has claimed */
  private myClaims = new Set<string>();
  private listeners = new Set<ReadOnlyListener>();
  private messagesListeners = new Set<MessagesListener>();
  private sessionListeners = new Set<SessionListener>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private beforeUnloadHandler: (() => void) | null = null;

  constructor() {
    this.tabId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (typeof BroadcastChannel === "undefined") {
      return; // No-op mode
    }

    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event: MessageEvent<TabMessage>) => {
      this.handleMessage(event.data);
    };

    // Heartbeat: send for our claims + check for stale claims from other tabs
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
      this.expireStaleClaimsFromOtherTabs();
    }, HEARTBEAT_INTERVAL_MS);

    // Best-effort release on tab close
    this.beforeUnloadHandler = () => this.releaseAll();
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.beforeUnloadHandler);
    }
  }

  /**
   * Attempt to claim a chatId for sending.
   * Returns false if another tab already holds it.
   */
  claim(chatId: string): boolean {
    if (!this.channel) return true; // No-op mode

    const existing = this.claims.get(chatId);
    if (existing && existing.tabId !== this.tabId) {
      return false; // Another tab holds this chat
    }

    this.myClaims.add(chatId);
    this.broadcast({ type: "claim", chatId, tabId: this.tabId });
    return true;
  }

  /** Release a chatId so other tabs can claim it. */
  release(chatId: string): void {
    if (!this.channel) return;
    if (!this.myClaims.has(chatId)) return;

    this.myClaims.delete(chatId);
    this.broadcast({ type: "release", chatId, tabId: this.tabId });
  }

  /** Check if THIS tab currently holds a claim for the chatId. */
  hasClaim(chatId: string): boolean {
    return this.myClaims.has(chatId);
  }

  /** Check if another tab holds this chatId. */
  isReadOnly(chatId: string): boolean {
    if (!this.channel) return false;

    const claim = this.claims.get(chatId);
    return claim != null && claim.tabId !== this.tabId;
  }

  addListener(fn: ReadOnlyListener): void {
    this.listeners.add(fn);
  }

  removeListener(fn: ReadOnlyListener): void {
    this.listeners.delete(fn);
  }

  /** Broadcast the current messages to other tabs (for real-time sync). */
  broadcastMessages(chatId: string, messages: unknown[]): void {
    if (!this.channel) return;
    this.broadcast({ type: "messages", chatId, tabId: this.tabId, messages });
  }

  addMessagesListener(fn: MessagesListener): void {
    this.messagesListeners.add(fn);
  }

  removeMessagesListener(fn: MessagesListener): void {
    this.messagesListeners.delete(fn);
  }

  /** Broadcast session state (lastEventId) to other tabs. */
  broadcastSession(chatId: string, session: { lastEventId?: string }): void {
    if (!this.channel) return;
    this.broadcast({ type: "session", chatId, tabId: this.tabId, session });
  }

  addSessionListener(fn: SessionListener): void {
    this.sessionListeners.add(fn);
  }

  removeSessionListener(fn: SessionListener): void {
    this.sessionListeners.delete(fn);
  }

  /** Clean up channel, timers, and event listeners. */
  dispose(): void {
    this.releaseAll();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.beforeUnloadHandler && typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.listeners.clear();
    this.messagesListeners.clear();
    this.sessionListeners.clear();
  }

  // --- Private ---

  private handleMessage(msg: TabMessage): void {
    if (msg.tabId === this.tabId) return; // Ignore own messages

    switch (msg.type) {
      case "claim": {
        const wasReadOnly = this.isReadOnly(msg.chatId);
        this.claims.set(msg.chatId, { tabId: msg.tabId, lastSeen: Date.now() });
        if (!wasReadOnly) {
          this.notify(msg.chatId, true);
        }
        break;
      }
      case "release": {
        const claim = this.claims.get(msg.chatId);
        if (claim && claim.tabId === msg.tabId) {
          this.claims.delete(msg.chatId);
          this.notify(msg.chatId, false);
        }
        break;
      }
      case "heartbeat": {
        const claim = this.claims.get(msg.chatId);
        if (claim && claim.tabId === msg.tabId) {
          claim.lastSeen = Date.now();
        }
        break;
      }
      case "messages": {
        this.notifyMessages(msg.chatId, msg.messages);
        break;
      }
      case "session": {
        this.notifySession(msg.chatId, msg.session);
        break;
      }
    }
  }

  private sendHeartbeats(): void {
    for (const chatId of this.myClaims) {
      this.broadcast({ type: "heartbeat", chatId, tabId: this.tabId });
    }
  }

  private expireStaleClaimsFromOtherTabs(): void {
    const now = Date.now();
    for (const [chatId, claim] of this.claims) {
      if (claim.tabId !== this.tabId && now - claim.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.claims.delete(chatId);
        this.notify(chatId, false);
      }
    }
  }

  private releaseAll(): void {
    for (const chatId of [...this.myClaims]) {
      this.release(chatId);
    }
  }

  private broadcast(msg: TabMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      // Channel may be closed
    }
  }

  private notify(chatId: string, isReadOnly: boolean): void {
    for (const fn of this.listeners) {
      try {
        fn(chatId, isReadOnly);
      } catch {
        // Non-fatal
      }
    }
  }

  private notifyMessages(chatId: string, messages: unknown[]): void {
    for (const fn of this.messagesListeners) {
      try {
        fn(chatId, messages);
      } catch {
        // Non-fatal
      }
    }
  }

  private notifySession(chatId: string, session: { lastEventId?: string }): void {
    for (const fn of this.sessionListeners) {
      try {
        fn(chatId, session);
      } catch {
        // Non-fatal
      }
    }
  }
}
