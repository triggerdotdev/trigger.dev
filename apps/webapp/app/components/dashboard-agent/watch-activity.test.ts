import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The key the module under test writes; kept here so a rename fails loudly in one place. */
const STORAGE_KEY = "tdev:dashboard-agent:watching";

type StorageListener = (event: { key: string | null }) => void;

const store = new Map<string, string>();
const storageListeners = new Set<StorageListener>();

// A minimal `window`: these tests run without a DOM.
const windowStub = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
  addEventListener: (_type: string, listener: StorageListener) =>
    void storageListeners.add(listener),
  removeEventListener: (_type: string, listener: StorageListener) =>
    void storageListeners.delete(listener),
};

const {
  forgetWatchActivity,
  hasWatchActivity,
  rememberWatchActivity,
  shouldPollWakeFeed,
  subscribeWatchActivity,
} = await import("./watch-activity");

/** What another tab writing the key looks like here. */
function otherTabWrote(organizationId: string) {
  store.set(STORAGE_KEY, JSON.stringify([organizationId]));
  for (const listener of storageListeners) listener({ key: STORAGE_KEY });
}

describe("watch activity", () => {
  beforeEach(() => {
    store.clear();
    storageListeners.clear();
    vi.stubGlobal("window", windowStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("knows nothing until a watch shows up", () => {
    expect(hasWatchActivity("org_1")).toBe(false);

    rememberWatchActivity("org_1");
    expect(hasWatchActivity("org_1")).toBe(true);
    expect(hasWatchActivity("org_2")).toBe(false);
  });

  it("survives a reload", () => {
    rememberWatchActivity("org_1");
    storageListeners.clear();

    expect(hasWatchActivity("org_1")).toBe(true);
  });

  it("tells a tab that was already open", () => {
    const woken: number[] = [];
    const unsubscribe = subscribeWatchActivity(() => woken.push(1));

    rememberWatchActivity("org_1");
    expect(woken).toHaveLength(1);

    unsubscribe();
    rememberWatchActivity("org_2");
    expect(woken).toHaveLength(1);
  });

  it("tells a tab about a watch another tab created", () => {
    const woken: number[] = [];
    const unsubscribe = subscribeWatchActivity(() => woken.push(1));

    otherTabWrote("org_1");

    expect(woken).toHaveLength(1);
    expect(hasWatchActivity("org_1")).toBe(true);
    unsubscribe();
  });

  it("forgets one organization without forgetting the others", () => {
    rememberWatchActivity("org_1");
    rememberWatchActivity("org_2");

    forgetWatchActivity("org_1");

    expect(hasWatchActivity("org_1")).toBe(false);
    expect(hasWatchActivity("org_2")).toBe(true);
  });

  it("remembers at most ten organizations", () => {
    for (let index = 0; index < 12; index++) rememberWatchActivity(`org_${index}`);

    expect(hasWatchActivity("org_0")).toBe(false);
    expect(hasWatchActivity("org_11")).toBe(true);
  });

  describe("a corrupt key", () => {
    it("reads as nothing known when the value is not an array", () => {
      store.set(STORAGE_KEY, JSON.stringify({ org_1: true }));

      expect(hasWatchActivity("org_1")).toBe(false);
      expect(shouldPollWakeFeed({ serverUnreadWakes: 0, organizationId: "org_1" })).toBe(false);
    });

    it("keeps the ids out of an array holding other things", () => {
      store.set(STORAGE_KEY, JSON.stringify([{ id: "org_1" }, "org_2", 7]));

      expect(hasWatchActivity("org_1")).toBe(false);
      expect(hasWatchActivity("org_2")).toBe(true);

      rememberWatchActivity("org_3");
      expect(store.get(STORAGE_KEY)).toBe(JSON.stringify(["org_2", "org_3"]));
    });
  });

  describe("shouldPollWakeFeed", () => {
    it("polls in a fresh browser the page load says has an unread wake", () => {
      expect(shouldPollWakeFeed({ serverUnreadWakes: 1, organizationId: "org_1" })).toBe(true);
    });

    it("stays quiet when neither the page load nor this browser knows of anything", () => {
      expect(shouldPollWakeFeed({ serverUnreadWakes: 0, organizationId: "org_1" })).toBe(false);
    });

    it("polls in a fresh browser whose only signal is an active watch", () => {
      // Created on another machine, nothing woken yet, no local marker.
      expect(
        shouldPollWakeFeed({
          serverUnreadWakes: 0,
          serverHasActiveWatches: true,
          organizationId: "org_1",
        })
      ).toBe(true);
    });

    it("stays quiet in a fresh browser with no wake and no active watch", () => {
      expect(
        shouldPollWakeFeed({
          serverUnreadWakes: 0,
          serverHasActiveWatches: false,
          organizationId: "org_1",
        })
      ).toBe(false);
    });

    it("polls without a reload once this browser sees a watch", () => {
      rememberWatchActivity("org_1");

      expect(shouldPollWakeFeed({ serverUnreadWakes: 0, organizationId: "org_1" })).toBe(true);
      expect(shouldPollWakeFeed({ serverUnreadWakes: 0, organizationId: "org_2" })).toBe(false);
    });
  });
});
