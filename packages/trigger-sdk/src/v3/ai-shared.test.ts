import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { anySignal } from "./ai-shared.js";

describe("anySignal", () => {
  it("returns a non-aborted signal when signals list is empty", () => {
    const signal = anySignal([]);
    expect(signal.aborted).toBe(false);
  });

  it("filters out null and undefined values", () => {
    const controller = new AbortController();
    const signal = anySignal([null, undefined, controller.signal, null]);
    expect(signal).toBe(controller.signal);
  });

  it("returns the single signal if only one valid signal is provided", () => {
    const controller = new AbortController();
    const signal = anySignal([controller.signal]);
    expect(signal).toBe(controller.signal);
  });

  describe("when AbortSignal.any is available (native)", () => {
    it("aborts when any of the input signals aborts", () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const combined = anySignal([c1.signal, c2.signal]);

      expect(combined.aborted).toBe(false);
      c2.abort("cancelled by c2");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("cancelled by c2");
    });
  });

  describe("fallback when AbortSignal.any is undefined (Safari < 17.4, Node < 20.3)", () => {
    const originalAny = AbortSignal.any;

    beforeEach(() => {
      // @ts-expect-error - simulating environment without AbortSignal.any
      delete AbortSignal.any;
    });

    afterEach(() => {
      AbortSignal.any = originalAny;
    });

    it("returns an immediately aborted signal if an input signal is already aborted", () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      c1.abort("already aborted reason");

      const combined = anySignal([c1.signal, c2.signal]);
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("already aborted reason");
    });

    it("aborts when the first signal is aborted", () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const combined = anySignal([c1.signal, c2.signal]);

      expect(combined.aborted).toBe(false);
      c1.abort("first reason");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("first reason");
    });

    it("aborts when the second signal is aborted", () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const combined = anySignal([c1.signal, c2.signal]);

      expect(combined.aborted).toBe(false);
      c2.abort("second reason");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("second reason");
    });

    it("cleans up event listeners on remaining signals when one signal aborts", () => {
      const c1 = new AbortController();
      const c2 = new AbortController();

      const c2RemoveSpy = vi.spyOn(c2.signal, "removeEventListener");
      const combined = anySignal([c1.signal, c2.signal]);

      expect(combined.aborted).toBe(false);
      c1.abort("first aborted");

      expect(combined.aborted).toBe(true);
      expect(c2RemoveSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });
});
