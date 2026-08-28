export type ComposerEscapeAction = "swallow" | "pass";

/**
 * The panel closes on Escape unless a child has already prevented the event's default —
 * `defaultPrevented` is how a child vetoes the close. Escape is two-step while a draft
 * exists: the first one is swallowed so the draft survives, a second consecutive one
 * passes through and closes the panel. Anything else re-arms the guard.
 */
export function composerEscapeAction(draft: string, guardArmed: boolean): ComposerEscapeAction {
  return draft.trim() !== "" && guardArmed ? "swallow" : "pass";
}
