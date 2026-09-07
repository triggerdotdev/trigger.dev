import { describe, expect, it } from "vitest";
import { shouldRunIntervalTick } from "./useInterval";

describe("shouldRunIntervalTick", () => {
  it("pauses a caller that says nothing, because the default is to pause", () => {
    expect(shouldRunIntervalTick(undefined, "hidden")).toBe(false);
    expect(shouldRunIntervalTick(undefined, "visible")).toBe(true);
  });

  it("keeps ticking while hidden only when a caller opts out on purpose", () => {
    expect(shouldRunIntervalTick(false, "hidden")).toBe(true);
    expect(shouldRunIntervalTick(false, "visible")).toBe(true);
  });

  it("pauses when a caller asks for it explicitly", () => {
    expect(shouldRunIntervalTick(true, "hidden")).toBe(false);
    expect(shouldRunIntervalTick(true, "visible")).toBe(true);
  });
});
