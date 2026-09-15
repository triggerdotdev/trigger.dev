// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createDockedWidthController } from "./docked-width";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  readAgentPanelWidth,
  writeAgentPanelWidth,
} from "./panel-layout";

describe("docked width controller", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves nothing for the size report that beats the dock", () => {
    const controller = createDockedWidthController();
    writeAgentPanelWidth(500);

    // The panel's own `updateConstraints` effect runs before this component's mode effect,
    // and reports the min-clamped size of the layout it just switched to.
    expect(controller.resize(AGENT_PANEL_MIN_WIDTH)).toEqual({ type: "none" });
    expect(controller.dragEnd(AGENT_PANEL_MIN_WIDTH)).toEqual({ type: "none" });
    expect(readAgentPanelWidth()).toBe(500);
  });

  it("waits for a measured panel before applying the saved width", () => {
    const controller = createDockedWidthController();
    // A panel that has never been laid out reports no usable width: sizing it now is what
    // produced the min-clamped column, so nothing is applied yet.
    expect(controller.dock(500, 0)).toEqual({ type: "none" });
    // The grid rendered the panel's `default`, which the panel now reports.
    expect(controller.resize(AGENT_PANEL_DEFAULT_WIDTH)).toEqual({ type: "apply", width: 500 });
    expect(controller.resize(500)).toEqual({ type: "none" });
  });

  it("ends a first dock without a saved width at the default", () => {
    const controller = createDockedWidthController();
    expect(readAgentPanelWidth()).toBe(AGENT_PANEL_DEFAULT_WIDTH);
    expect(controller.dock(AGENT_PANEL_DEFAULT_WIDTH, undefined)).toEqual({ type: "none" });
    // The default is what the grid already renders, so there is nothing to apply and
    // nothing may narrow it to the min.
    expect(controller.resize(AGENT_PANEL_MIN_WIDTH)).toEqual({
      type: "apply",
      width: AGENT_PANEL_DEFAULT_WIDTH,
    });
    expect(controller.resize(AGENT_PANEL_DEFAULT_WIDTH)).toEqual({ type: "none" });
  });

  it("applies the saved width straight away on a later dock", () => {
    const controller = createDockedWidthController();
    expect(controller.dock(500, AGENT_PANEL_DEFAULT_WIDTH)).toEqual({ type: "apply", width: 500 });
    expect(controller.dragEnd(640)).toEqual({ type: "persist", width: 640 });
  });

  it("persists only a finished drag, and only a width the panel can hold", () => {
    const controller = createDockedWidthController();
    controller.dock(500, 380);
    controller.resize(500);
    expect(controller.dragEnd(499)).toEqual({ type: "persist", width: 499 });
    expect(controller.dragEnd(10)).toEqual({ type: "none" });
    expect(controller.dragEnd(5000)).toEqual({ type: "none" });
    expect(controller.dragEnd(undefined)).toEqual({ type: "none" });
  });

  it("blocks saving again after undocking, until the next dock has applied", () => {
    const controller = createDockedWidthController();
    controller.dock(500, 380);
    controller.resize(500);
    expect(controller.undock()).toEqual({ type: "none" });
    expect(controller.dragEnd(320)).toEqual({ type: "none" });
    controller.dock(500, 0);
    expect(controller.dragEnd(320)).toEqual({ type: "none" });
  });
});
