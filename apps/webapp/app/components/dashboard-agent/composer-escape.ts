/**
 * The panel closes on Escape unless a child has already prevented the event's default —
 * `defaultPrevented` is how a child vetoes the close. A composer holding a draft takes the
 * first Escape for itself, so the draft survives; an empty one lets Escape close the panel.
 */
export function composerKeepsEscape(value: string): boolean {
  return value.trim() !== "";
}
