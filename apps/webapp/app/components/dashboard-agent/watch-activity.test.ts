import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { forgetWatchActivity, hasWatchActivity, rememberWatchActivity, subscribeWatchActivity } =
  await import("./watch-activity");

/** What another tab writing the key looks like here. */
function otherTabWrote(organizationId: string) {
  store.set("tdev:dashboard-agent:watching", JSON.stringify([organizationId]));
  for (const listener of storageListeners) listener({ key: "tdev:dashboard-agent:watching" });
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
});
