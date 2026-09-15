import { AGENT_PANEL_MAX_WIDTH, AGENT_PANEL_MIN_WIDTH } from "./panel-layout";

/**
 * Decides when the agent panel's saved width may be applied and when a width is worth
 * saving. Extracted because the ordering is the whole problem: the panel's own
 * `updateConstraints` effect reports a size before the parent's mode effect runs, so any
 * "persist whatever the panel reports" rule saves that min-clamped size over the user's.
 *
 * Only a finished drag writes a width; every other report can do nothing but satisfy a
 * pending apply.
 */
export type DockedWidthAction =
  | { type: "none" }
  | { type: "apply"; width: number }
  | { type: "persist"; width: number };

const NONE: DockedWidthAction = { type: "none" };

function isUsableDockedWidth(width: number | undefined): width is number {
  return (
    typeof width === "number" &&
    Number.isFinite(width) &&
    width >= AGENT_PANEL_MIN_WIDTH &&
    width <= AGENT_PANEL_MAX_WIDTH
  );
}

export function createDockedWidthController() {
  // Starts blocked: nothing may be saved until a dock has applied its own width.
  let pending: number | null = null;
  let applied = false;

  return {
    /**
     * Docking: the saved width is what we want, but only a panel the layout has already
     * measured can take it — sizing a cold panel yields a negative fraction that the grid
     * clamps to `min`, which is the bug this indirection exists for. Until then the grid
     * renders the panel's `default`, and the first size report applies the saved width.
     */
    dock(saved: number, current: number | undefined): DockedWidthAction {
      applied = false;
      if (isUsableDockedWidth(current)) {
        pending = null;
        applied = true;
        return Math.round(current) === saved ? NONE : { type: "apply", width: saved };
      }
      pending = saved;
      return NONE;
    },
    undock(): DockedWidthAction {
      pending = null;
      applied = false;
      return NONE;
    },
    /** The panel reported a size. Only ever used to retry a pending apply. */
    resize(pixel: number): DockedWidthAction {
      if (pending === null || !isUsableDockedWidth(pixel)) return NONE;
      if (Math.round(pixel) === pending) {
        pending = null;
        applied = true;
        return NONE;
      }
      const width = pending;
      pending = null;
      applied = true;
      // The first report is the panel's own layout, so the saved width can land now.
      return { type: "apply", width };
    },
    /** A finished drag is the only thing that changes the saved width. */
    dragEnd(measured: number | undefined): DockedWidthAction {
      if (!applied || !isUsableDockedWidth(measured)) return NONE;
      return { type: "persist", width: Math.round(measured) };
    },
  };
}
