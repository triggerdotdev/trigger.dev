import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetLastChat,
  lastChatStorageKey,
  readLastChat,
  shouldPersistLastChat,
  writeLastChat,
} from "./last-chat-storage";

const ORG_A = "org_a";
const ORG_B = "org_b";
const KEY_A = lastChatStorageKey(ORG_A);
const KEY_B = lastChatStorageKey(ORG_B);

const chatOfA = { chatId: "chat_a1", organizationId: ORG_A };

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldPersistLastChat", () => {
  it("persists a chat under its own org", () => {
    expect(shouldPersistLastChat(chatOfA, ORG_A)).toBe(true);
  });

  // The org-reset effect clears `active` in a later flush, so the persistence effect runs
  // once with the previous org's chat and the new org's key.
  it("does not persist the previous org's chat once the org has switched", () => {
    expect(shouldPersistLastChat(chatOfA, ORG_B)).toBe(false);
  });

  it("persists nothing when there is no chat", () => {
    expect(shouldPersistLastChat(null, ORG_A)).toBe(false);
  });
});

describe("last chat storage across an org switch", () => {
  it("leaves the new org's key untouched when the panel still holds the old org's chat", () => {
    writeLastChat(KEY_A, { chatId: chatOfA.chatId, path: "/orgs/a/runs" });
    if (shouldPersistLastChat(chatOfA, ORG_B)) {
      writeLastChat(KEY_B, { chatId: chatOfA.chatId, path: "/orgs/b/runs" });
    }

    expect(readLastChat(KEY_B)).toBeNull();
    expect(readLastChat(KEY_A)).toEqual({ chatId: chatOfA.chatId, path: "/orgs/a/runs" });
  });

  it("forgets a pointer to a chat that is gone", () => {
    writeLastChat(KEY_A, { chatId: chatOfA.chatId, path: "/orgs/a/runs" });
    forgetLastChat(KEY_A);

    expect(readLastChat(KEY_A)).toBeNull();
    expect(store.has(KEY_A)).toBe(false);
  });

  it("ignores a pre-path entry that was just the chat id", () => {
    store.set(KEY_A, "chat_a1");

    expect(readLastChat(KEY_A)).toBeNull();
  });
});
