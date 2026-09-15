// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staleAssetRecoveryScript } from "./StaleAssetRecovery";

// Each staleAssetRecoveryScript() call models a fresh page load: it reads the shared
// sessionStorage budget and returns its own `recover`. We drive recover() directly rather
// than dispatching resource-error events, so accumulated window listeners never fire.
describe("staleAssetRecoveryScript", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads on a recovery", () => {
    staleAssetRecoveryScript().recover();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads only once per page even if several assets fail (re-entrancy guard)", () => {
    const { recover } = staleAssetRecoveryScript();
    recover();
    recover();
    recover();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops reloading once the budget is spent across reloads", () => {
    staleAssetRecoveryScript().recover(); // reload 1
    staleAssetRecoveryScript().recover(); // reload 2
    staleAssetRecoveryScript().recover(); // budget spent -> no reload
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when offline", () => {
    vi.stubGlobal("navigator", { onLine: false });
    staleAssetRecoveryScript().recover();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload when sessionStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    staleAssetRecoveryScript().recover();
    expect(reload).not.toHaveBeenCalled();
  });
});
